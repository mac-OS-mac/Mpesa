const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const sql = require('mssql');
require('dotenv').config();

const app = express();

// Middleware to parse JSON requests
app.use(bodyParser.json());

// Azure SQL Database configuration
const config = {
    server: 'mpesadb-server.database.windows.net',
    database: 'mpesa_payments',
    user: 'mpesadb-server',
    password: process.env.DB_PASSWORD,
    options: {
        encrypt: true,
        trustServerCertificate: false,
        connectTimeout: 30000
    }
};

// Test the database connection
async function testConnection() {
    try {
        await sql.connect(config);
        console.log('Connected to Azure SQL Database');
        const result = await sql.query`SELECT 1 + 1 AS solution`;
        console.log('Test query result:', result.recordset[0].solution);
    } catch (err) {
        console.error('Error connecting to the database:', err);
    }
}

testConnection();

// Middleware to log API requests and responses
app.use(async (req, res, next) => {
    const logEntry = {
        endpoint: req.originalUrl,
        request_payload: JSON.stringify(req.body),
        response_payload: JSON.stringify(res.body),
        status_code: res.statusCode
    };

    try {
        await sql.connect(config);
        const request = new sql.Request();
        const query = `
            INSERT INTO api_logs (endpoint, request_payload, response_payload, status_code)
            VALUES (@endpoint, @request_payload, @response_payload, @status_code)
        `;
        request.input('endpoint', sql.VarChar, logEntry.endpoint);
        request.input('request_payload', sql.Text, logEntry.request_payload);
        request.input('response_payload', sql.Text, logEntry.response_payload);
        request.input('status_code', sql.Int, logEntry.status_code);
        await request.query(query);
    } catch (err) {
        console.error('Error logging API request:', err.message);
    } finally {
        next(); // Pass control to the next middleware or route handler
    }
});

// Constants for M-Pesa API credentials
const MPESA_CREDENTIALS = {
    CONSUMER_KEY: process.env.CONSUMER_KEY,
    CONSUMER_SECRET: process.env.CONSUMER_SECRET,
    SHORT_CODE: process.env.SHORT_CODE,
    PASSKEY: process.env.PASSKEY,
    CALLBACK_URL: process.env.CALLBACK_URL,
    MPESA_AUTH_URL: 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    MPESA_STK_PUSH_URL: 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
};

// Function to generate M-Pesa authentication token
async function generateMpesaToken() {
    try {
        const auth = Buffer.from(`${MPESA_CREDENTIALS.CONSUMER_KEY}:${MPESA_CREDENTIALS.CONSUMER_SECRET}`).toString('base64');
        const response = await axios.get(MPESA_CREDENTIALS.MPESA_AUTH_URL, {
            headers: { Authorization: `Basic ${auth}` }
        });
        return response.data.access_token;
    } catch (error) {
        console.error('Error generating M-Pesa token:', error.message);
        throw new Error('Failed to generate M-Pesa token');
    }
}

// Function to initiate STK Push
async function initiateSTKPush(phoneNumber, amount, orderId, token) {
    try {
        const timestamp = new Date().toISOString().split('T')[0].replace(/-/g, '');
        const password = Buffer.from(`${MPESA_CREDENTIALS.SHORT_CODE}${MPESA_CREDENTIALS.PASSKEY}${timestamp}`).toString('base64');

        const response = await axios.post(MPESA_CREDENTIALS.MPESA_STK_PUSH_URL, {
            BusinessShortCode: MPESA_CREDENTIALS.SHORT_CODE,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: amount,
            PartyA: phoneNumber,
            PartyB: MPESA_CREDENTIALS.SHORT_CODE,
            PhoneNumber: phoneNumber,
            CallBackURL: MPESA_CREDENTIALS.CALLBACK_URL,
            AccountReference: orderId,
            TransactionDesc: `Payment for Order ${orderId}`
        }, {
            headers: { Authorization: `Bearer ${token}` }
        });

        return response.data;
    } catch (error) {
        console.error('Error initiating STK Push:', error.message);
        throw new Error('Failed to initiate STK Push');
    }
}

// Endpoint to initiate M-Pesa payment
app.post('/initiate-payment', async (req, res) => {
    const { phone_number, amount, order_id, customer_email } = req.body;

    // Validate request body
    if (!phone_number || !amount || !order_id || !customer_email) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        // Generate M-Pesa token
        const token = await generateMpesaToken();

        // Initiate STK Push
        const stkPushResponse = await initiateSTKPush(phone_number, amount, order_id, token);

        // Save transaction to the database
        const transaction = {
            transaction_id: stkPushResponse.CheckoutRequestID, // Use CheckoutRequestID as transaction_id
            phone_number,
            amount,
            status: 'Pending',
            description: `Payment for Order ${order_id}`
        };

        await sql.connect(config);
        const request = new sql.Request();
        const query = `
            INSERT INTO transactions (transaction_id, phone_number, amount, status, description)
            VALUES (@transaction_id, @phone_number, @amount, @status, @description)
        `;
        request.input('transaction_id', sql.VarChar, transaction.transaction_id);
        request.input('phone_number', sql.VarChar, transaction.phone_number);
        request.input('amount', sql.Decimal, transaction.amount);
        request.input('status', sql.VarChar, transaction.status);
        request.input('description', sql.VarChar, transaction.description);
        const result = await request.query(query);

        // Return success response
        res.status(200).json({
            message: 'Payment initiated successfully',
            data: stkPushResponse,
            transactionId: result.recordset.insertId // Return the ID of the inserted record
        });
    } catch (error) {
        console.error('Error in /initiate-payment:', error.message);
        res.status(500).json({ error: error.message || 'Failed to initiate payment' });
    }
});

// Callback endpoint for M-Pesa
app.post('/callback', async (req, res) => {
    const callbackData = req.body;
    console.log('Payment Callback:', callbackData);

    // Extract relevant data from the callback
    const { ResultCode, CheckoutRequestID, MpesaReceiptNumber } = callbackData;

    // Determine payment status based on ResultCode
    const paymentStatus = ResultCode === '0' ? 'Success' : 'Failed';

    try {
        await sql.connect(config);
        const request = new sql.Request();
        const query = `
            UPDATE transactions
            SET status = @status, mpesa_receipt_number = @mpesa_receipt_number
            WHERE transaction_id = @transaction_id
        `;
        request.input('status', sql.VarChar, paymentStatus);
        request.input('mpesa_receipt_number', sql.VarChar, MpesaReceiptNumber);
        request.input('transaction_id', sql.VarChar, CheckoutRequestID);
        await request.query(query);

        console.log('Transaction status updated successfully');
        res.status(200).send('Callback received and transaction status updated');
    } catch (err) {
        console.error('Error updating transaction status:', err.message);
        res.status(500).send('Failed to update transaction status');
    }
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));