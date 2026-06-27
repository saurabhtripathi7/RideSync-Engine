import app from "./app.js";
import { connectQueue } from "./queues/queue.connection.js";

const PORT = 3000;

async function start(): Promise<void> {
  await connectQueue();
  app.listen(PORT, () => {
    console.log(`[server] Running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Server failed to start:", err);
  process.exit(1);
});