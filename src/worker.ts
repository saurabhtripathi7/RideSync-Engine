// worker.ts — The Process Entry Point 
// Purpose: This is what Node.js actually runs (tsx src/worker.ts). It connects to RabbitMQ then starts all workers.

import { connectQueue } from "./queues/queue.connection.js";
import { startRideWorker } from "./workers/ride.worker.js";

async function startWorkers(): Promise<void> {
  await connectQueue();
  startRideWorker();
  console.log("[workers] All workers started");
}

startWorkers().catch((err) => {
  console.error("Failed to start workers:", err);
  process.exit(1);
});


// tsx src/server.ts → handles HTTP requests, publishes to queue
// tsx src/worker.ts → listens to queue, runs pooling logic
// Both call connectQueue() independently, so both get their own TCP connection to RabbitMQ.