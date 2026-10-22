// Integration-only entry point. Production Wrangler uses src/index.ts directly.
import worker from '../src/index';
import type { Env, Task } from '../src/types';

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === '/__test/queue' && request.method === 'POST') {
      const body = await request.json() as Task;
      let acknowledged = false;
      let retry: QueueRetryOptions | null = null;
      const message = {
        id: 'integration-message', timestamp: new Date(), body, attempts: 1,
        ack() { acknowledged = true; },
        retry(options?: QueueRetryOptions) { retry = options || {}; },
      } as Message<Task>;
      const batch = {
        queue: 'hireflow-applications', messages: [message], metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        ackAll() { acknowledged = true; },
        retryAll(options?: QueueRetryOptions) { retry = options || {}; },
      } as MessageBatch<Task>;
      await worker.queue(batch, env);
      return Response.json({ acknowledged, retry });
    }
    return worker.fetch(request, env);
  },
};
