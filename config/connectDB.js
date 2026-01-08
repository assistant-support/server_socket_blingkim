// config/connectDB.js
import mongoose from 'mongoose';
import { MongoDB_URI } from './environment.js';

let isConnected = false;

const connectDB = async () => {
    if (isConnected) return;

    if (mongoose.connections[0].readyState) { 
        isConnected = true; 
        return;
    }

    try {
        if (!MongoDB_URI) {
            console.error('[MongoDB] ❌ MongoDB URI not found. Please set one of these environment variables in .env file:');
            console.error('[MongoDB]    - MongoDB_URI');
            console.error('[MongoDB]    - MONGODB_URI');
            console.error('[MongoDB]    - MONGO_URI');
            console.error('[MongoDB]    - MONGODB_URL');
            console.error('[MongoDB]    - DATABASE_URL');
            throw new Error('MongoDB URI is not defined in environment variables');
        }
        
        const db = await mongoose.connect(MongoDB_URI);
        isConnected = db.connections[0].readyState === 1;
        console.log('[MongoDB] ✅ Connected successfully');
    } catch (error) {
        console.error('[MongoDB] ❌ Connection error:', error.message);
        throw new Error('Failed to connect to MongoDB: ' + error.message);
    }
};

export default connectDB;

