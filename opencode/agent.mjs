// OpenCode's equivalent of a permission mode is an agent, and a primary
// agent joins the Shift+Tab cycle automatically. Registered here rather
// than shipped as a config file so installing the plugin IS installing the
// mode; a user's own `agents.probe` (config or .opencode/agents/probe.md)
// wins if it already exists when we load.
export async function registerAgent({ ctx }) {
  await ctx.agent.transform((editor) => {
    if (editor.get('probe')) return;
    editor.update('probe', (agent) => {
      agent.name = 'Probe';
      agent.description =
        'Research-only mode: explores, benchmarks and proves ideas in a sandbox; writes stay blocked until a plan is approved.';
      agent.mode = 'primary';
      agent.color = '#4ea1ff';
      agent.permissions.push({ action: 'question', resource: '*', effect: 'allow' });
    });
  });
}
