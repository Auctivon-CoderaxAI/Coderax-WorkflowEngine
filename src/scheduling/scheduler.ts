/**
 * The bounded execution queue for accepted Work tasks.
 *
 * This is not a second scheduler: `engine.ts` is the durable recurrence engine,
 * and it admits a scheduled occurrence through this same queue after
 * orchestration has written the task and claimed its lease. There is one
 * execution path for client work and scheduled work alike.
 *
 * Submission returns before execution finishes, so the queue is what makes a
 * task durable from the caller's point of view: the caller may disconnect, and
 * the scheduler still starts the run. Concurrency is bounded so a burst of tasks
 * cannot exhaust the host or the free-inference budget at once.
 */
export type TaskScheduler = {
  /** Returns false if the scheduler has stopped accepting work. */
  enqueue: (job: () => Promise<void>) => boolean;
  active: () => number;
  pending: () => number;
  /** Test and shutdown support: resolves once the queue and pool are empty. */
  idle: () => Promise<void>;
  stop: () => void;
};

export function createTaskScheduler(input: { maxConcurrent: number }): TaskScheduler {
  const queue: Array<() => Promise<void>> = [];
  const running = new Set<Promise<void>>();
  let stopped = false;

  function pump(): void {
    while (!stopped && running.size < input.maxConcurrent && queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      const promise: Promise<void> = job()
        .catch(() => undefined)
        .finally(() => {
          running.delete(promise);
          pump();
        });
      running.add(promise);
    }
  }

  return {
    enqueue: (job) => {
      if (stopped) return false;
      queue.push(job);
      pump();
      return true;
    },
    active: () => running.size,
    pending: () => queue.length,
    idle: async () => {
      while (running.size > 0 || queue.length > 0) {
        if (running.size > 0) {
          await Promise.allSettled([...running]);
        } else {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }
    },
    stop: () => {
      stopped = true;
      queue.length = 0;
    },
  };
}
