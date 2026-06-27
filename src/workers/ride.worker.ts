// ride.worker.ts — The Receiver
// Purpose: A separate long-running process that listens to the queue and calls processRide() for each message.

import prisma from "../db/prisma.js";
import { getChannel, QUEUES } from "../queues/queue.connection.js";
import { processRide } from "../services/pooling.service.js";
import { RideStatus } from "../db/prisma-client/enums.js";

export function startRideWorker(): void {
  const channel = getChannel();

  // Only give this worker 1 message at a time.
  // Next message only arrives after we ack the current one.
  channel.prefetch(1);

  channel.consume(QUEUES.RIDE_REQUESTED, async (msg) => {
    if (!msg) return;

    try {
      const payload = JSON.parse(msg.content.toString());
      const { rideId } = payload;

      console.log(`[ride.worker] Processing rideId: ${rideId}`);

      // Guard: if already matched by another worker, skip
      const ride = await prisma.ride.findUnique({ where: { id: rideId } });
      if (!ride || ride.status !== RideStatus.SEARCHING) { // prevents double processing. If somehow the same ride got published twice, we ack and skip instead of running processRide twice
        channel.ack(msg);
        return;
      }

      await processRide(rideId);

      // ack must be called after successful processing. Without this, message stays "in flight" and RabbitMQ will redeliver it when the channel closes
      channel.ack(msg); // tell RabbitMQ: done, discard this message
      console.log(`[ride.worker] Done: ${rideId}`);
    } catch (err) {
      console.error("[ride.worker] Error:", err);
      channel.nack(msg, false, true); // requeue: true → RabbitMQ will retry
      // channel.nack(msg, false, true) — args are: (msg, allUpTo, requeue). 
      // false means only nack this one message, true means put it back in queue for retry
    }
  });

  console.log(`[ride.worker] Listening on ${QUEUES.RIDE_REQUESTED}`);
}