// Status row for probe mode in the OpenCode footer — the counterpart of
// Claude Code's statusLine. Prints nothing at all while probe mode is off, so
// it stays invisible until you actually run /probe.
//
// Reactivity: phase changes are file writes by the server plugin, so nothing
// pushes an event for them. The row therefore refreshes on relevant session
// events (permission replies are the interesting one: that is the approval
// landing) and on a 2s tick as a self-healing backstop. Unlike Claude Code's
// status line — which spawns a four-process chain per tick on Windows — this
// runs in-process, so a short tick costs a single file read.
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createSignal, onCleanup, Show } from "solid-js"
import { readState, normalizeRounds } from "../shared/state.mjs"

const stateDir = () => process.env.PROBE_STATE_DIR || path.join(os.homedir(), ".probe-mode")

type View = { phase: string; round: number; restore: string }

// `{r}` is where the round suffix lands (`probe r2: planning`), matching Claude
// Code's statusline wording one-for-one.
const LOOK: Record<
  string,
  { label: string; note: string; tone: "warning" | "info" | "success" }
> = {
  probe: {
    label: "probe{r} mode on",
    note: "research only",
    tone: "warning",
  },
  planning: {
    label: "probe{r}: planning",
    note: "awaiting approval",
    tone: "info",
  },
  implementing: {
    label: "probe{r}: unlocked",
    note: "writes allowed",
    tone: "success",
  },
}

function viewOf(sessionID?: string): View | undefined {
  if (!sessionID) return undefined
  const state = readState(stateDir(), sessionID)
  if (!state || !LOOK[state.phase]) return undefined
  // The current round's restore point is what `restore` defaults to.
  const rounds = normalizeRounds(state)
  const round = state.round || 1
  const restore = rounds.some((r) => r.n === round)
    ? "\u27f2 /probe restore"
    : "no restore point"
  return { phase: state.phase, round, restore }
}

export default Plugin.define({
  id: "probe-mode.tui",
  setup(context) {
    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => <StatusRow sessionID={input.sessionID} />,
    })
  },
})

function StatusRow(props: { sessionID?: string }) {
  const context = usePlugin()
  const [tick, setTick] = createSignal(0)

  const stop = context.data.listen(({ details }) => {
    const type = String(details?.type ?? "")
    if (
      type.startsWith("permission.") ||
      type.startsWith("session.message") ||
      type.startsWith("session.status") ||
      type.startsWith("session.agent")
    ) {
      setTick((value) => value + 1)
    }
  })
  const timer = setInterval(() => setTick((value) => value + 1), 2000)
  onCleanup(() => {
    clearInterval(timer)
    stop()
  })

  const view = () => {
    tick() // re-read the state file whenever anything might have moved it
    return viewOf(props.sessionID)
  }

  return (
    <Show when={view()} keyed>
      {(current) => {
        const look = LOOK[current.phase]
        const round = current.round > 1 ? ` r${current.round}` : ""
        const label = look.label.replace("{r}", round)
        return (
          <text>
            <span style={{ fg: context.theme.text.feedback[look.tone].base }}>
              <b>{`⏸ ${label}`}</b>
            </span>
            <span style={{ fg: context.theme.text.muted }}>{` · ${look.note} · ${current.restore}`}</span>
          </text>
        )
      }}
    </Show>
  )
}
