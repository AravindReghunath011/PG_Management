import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Set MONGODB_URI in `.env` to either:
 * - Local:  mongodb://localhost:27017/pg_management
 * - Atlas:  mongodb+srv://USER:PASS@CLUSTER.mongodb.net/pg_management?retryWrites=true&w=majority
 *
 * Paste your Atlas connection string into MONGODB_URI when you have it — no code changes needed.
 */
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/pg_management';

/** Hide credentials when logging connection strings. */
function redactUri(uri: string): string {
  return uri.replace(/\/\/([^:/@]+):([^@]+)@/, '//$1:***@');
}

export const connectDB = async (): Promise<void> => {
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 10_000,
    });
    console.log('MongoDB connected successfully to:', redactUri(MONGODB_URI));
  } catch (error) {
    console.error('MongoDB connection failed:', error);
    process.exit(1);
  }
};

export const disconnectDB = async (): Promise<void> => {
  try {
    await mongoose.connection.close();
    console.log('MongoDB connection closed.');
  } catch (error) {
    console.error('Error during MongoDB disconnect:', error);
  }
};
