import type { AgentSession } from "./agent-sdk-types.js";

/** Manager-facing view only. The controller retains the original session.
 * Enumerate inspection methods so future provider mutations are denied by default.
 */
export function controllerSessionView(
  session: AgentSession,
  controls: { stop(): Promise<void>; assertSettled(): Promise<void> },
): AgentSession {
  const refuse = async (): Promise<never> => {
    throw new Error("Controller-managed execution must be controlled through its controller.");
  };
  return {
    provider: session.provider,
    get id() {
      return session.id;
    },
    capabilities: {
      ...session.capabilities,
      supportsDynamicModes: false,
      supportsRewindConversation: false,
      supportsRewindFiles: false,
      supportsRewindBoth: false,
    },
    features: [],
    subscribe: (callback) => session.subscribe(callback),
    streamHistory: () => session.streamHistory(),
    getRuntimeInfo: () => session.getRuntimeInfo(),
    getAvailableModes: async () => [],
    getCurrentMode: () => session.getCurrentMode(),
    getPendingPermissions: () => session.getPendingPermissions(),
    describePersistence: () => session.describePersistence(),
    run: refuse,
    startTurn: refuse,
    steerActiveTurn: refuse,
    setMode: refuse,
    respondToPermission: refuse,
    setModel: refuse,
    setThinkingOption: refuse,
    setFeature: refuse,
    revertConversation: refuse,
    revertFiles: refuse,
    revertBoth: refuse,
    interrupt: controls.stop,
    close: controls.assertSettled,
    listCommands: async () => [],
  };
}
