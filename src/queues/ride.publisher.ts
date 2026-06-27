// The API server uses this to drop messages into the queue. It doesn't care who picks them up or when.

import { getChannel, QUEUES } from "./queue.connection.js";

export interface RideRequestedEvent {
  rideId: string;
}

export interface RideCancelledEvent {
  rideId: string;
  poolId: string;
}

export function publishRideRequested(payload: RideRequestedEvent): void {
  const channel = getChannel();

  // sendToQueue(queueName, buffer, options) — puts the message into the named queue
  channel.sendToQueue(
    QUEUES.RIDE_REQUESTED,
    Buffer.from(JSON.stringify(payload)),  // Buffer.from(JSON.stringify(payload)) — converts { rideId: "abc" } → '{"rideId":"abc"}' → raw bytes
    { persistent: true } // survives RabbitMQ restart
  );

  console.log(`[publisher] ride.requested → rideId: ${payload.rideId}`);
}

export function publishRideCancelled(payload: RideCancelledEvent): void {
  const channel = getChannel();

  channel.sendToQueue(
    QUEUES.RIDE_CANCELLED,
    Buffer.from(JSON.stringify(payload)),
    { persistent: true }
  );

  console.log(`[publisher] ride.cancelled → rideId: ${payload.rideId}`);
}