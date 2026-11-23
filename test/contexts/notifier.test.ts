import { describe, it, expect } from '../support/harness.ts';
import { ViewNotifier } from '../../src/contexts/notifier.ts';
import type { ContextsView } from '../../src/contexts/types.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('view notifier', () => {
  it('a_burst_of_agent_events_recomputes_the_view_once', async () => {
    let computed = 0;
    const notifier = new ViewNotifier(async () => { computed += 1; return { contexts: [] } as unknown as ContextsView; });
    for (let i = 0; i < 10; i++) notifier.schedule();
    await wait(400);
    expect(computed).toBe(1);
    notifier.stop();
  });

  it('an_event_after_the_refresh_recomputes_again', async () => {
    let computed = 0;
    const notifier = new ViewNotifier(async () => { computed += 1; return { contexts: [] } as unknown as ContextsView; });
    notifier.schedule();
    await wait(400);
    notifier.schedule();
    await wait(400);
    expect(computed).toBe(2);
    notifier.stop();
  });
});
