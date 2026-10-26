// The permission-dialog path: track `edit` requests raised while planning,
// and treat the user's Allow as the approval. `asked` carries the action,
// which is what keeps an unrelated approval (a .env read, an external
// directory) from unlocking anything. Returns a stop function.
export function watchApprovals({ ctx }, session) {
  const approvalDialogs = new Map();
  const abort = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
        if (event.type === 'permission.asked') {
          const data = event.data;
          if (data.action !== 'edit') continue;
          // Only a dialog raised while a plan awaits approval is an approval.
          const armed = await session.armedFor(data.sessionID);
          if (armed?.state.phase !== 'planning') continue;
          approvalDialogs.set(data.id, data.sessionID);
          // Unbounded growth would need a clock we do not have here; a lost
          // entry only means the user runs `/probe approve` instead — the
          // failure direction is staying locked.
          if (approvalDialogs.size > 500) approvalDialogs.clear();
        } else if (event.type === 'permission.replied') {
          const data = event.data;
          if (data.reply === 'reject' || !approvalDialogs.has(data.requestID)) continue;
          approvalDialogs.delete(data.requestID);
          await session.unlock(data.sessionID, 'permission');
        }
      }
    } catch {
      // Stream closed or plugin unloading: stop watching.
    }
  })();
  return () => abort.abort();
}
