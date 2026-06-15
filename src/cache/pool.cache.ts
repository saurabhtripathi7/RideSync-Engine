import redis from "./redis.client.js";

// Creates a pool-specific lock key
// Example: lock:pool:123
const lockKey = (poolId: string) => `lock:pool:${poolId}`; // just for ...

// Tries to acquire an exclusive lock on a pool.
// Returns true if lock was acquired, false if another worker already holds it.

//   NX  = only set if key does NOT exist (atomic, guaranteed by Redis)
//   EX 5 = auto-expire after 5 seconds if worker crashes mid-operation

// workerId is stored as the lock value so we know which worker currently owns the pool lock.
export async function acquirePoolLock(
  poolId: string,
  workerId: string
): Promise<boolean> {
  const result = await redis.set(lockKey(poolId), workerId, "EX", 5, "NX");
  return result === "OK";
}

export async function releasePoolLock(poolId: string): Promise<void> {
  await redis.del(lockKey(poolId));
}