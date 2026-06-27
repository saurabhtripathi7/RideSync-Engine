// Purpose: Create and own the connection + channel. Everyone else imports getChannel() from here. 
// This prevents you from creating 50 different connections across your codebase.
// This file owns the single RabbitMQ connection and channel. 
// Both the server (publisher) and worker (consumer) import from here.

import amqp from "amqplib"; // Advanced Message Queuing Protocol library

export const QUEUES = {
  RIDE_REQUESTED: "ride.requested",
  RIDE_CANCELLED: "ride.cancelled",
};

let channel: amqp.Channel | null = null;

export async function connectQueue(): Promise<void> {
  const connection = await amqp.connect(
    process.env.RABBITMQ_URL || "amqp://localhost:5672"
  );

  channel = await connection.createChannel();

  // durable: true → queue survives RabbitMQ restart
  await channel.assertQueue(QUEUES.RIDE_REQUESTED, { durable: true });
  await channel.assertQueue(QUEUES.RIDE_CANCELLED, { durable: true });
  // assertQueue(name, { durable: true }) — "make sure this queue exists, create it if it doesn't, and make it durable". 
  // Safe to call multiple times — it's idempotent.

  console.log("[rabbitmq] Connected");
}

export function getChannel(): amqp.Channel {
  if (!channel) {
    throw new Error("RabbitMQ channel not initialized. Call connectQueue() first.");
  }
  return channel;
}