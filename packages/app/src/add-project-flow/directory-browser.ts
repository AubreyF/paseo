import type {
  ProjectDirectoryBrowsePayload,
  ProjectDirectoryBrowseRequest,
} from "@getpaseo/protocol/messages";

type BrowseInput = Omit<ProjectDirectoryBrowseRequest, "type" | "requestId">;
interface BrowserState {
  input: string;
  request: BrowseInput;
  result: ProjectDirectoryBrowsePayload | null;
  loading: boolean;
  error: string | null;
}
interface BrowserPort {
  browseProjectDirectories(input: BrowseInput): Promise<ProjectDirectoryBrowsePayload>;
}

export function openDirectoryBrowser(client: BrowserPort) {
  let state: BrowserState = { input: "", request: {}, result: null, loading: false, error: null };
  let generation = 0;
  const listeners = new Set<() => void>();
  function publish(update: Partial<BrowserState>) {
    state = { ...state, ...update };
    for (const listener of listeners) listener();
  }
  async function browse(request: BrowseInput) {
    const current = ++generation;
    publish({ request, loading: true, error: null });
    try {
      const result = await client.browseProjectDirectories(request);
      if (current !== generation) return;
      publish({ result, loading: false, error: result.error });
    } catch (error) {
      if (current !== generation) return;
      publish({
        loading: false,
        error: error instanceof Error ? error.message : "Unable to browse folders",
      });
    }
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setInput(input: string) {
      publish({ input });
    },
    browse,
    openHostPath() {
      return browse({ hostPath: state.input, showHidden: state.request.showHidden });
    },
    close() {
      generation++;
      listeners.clear();
    },
  };
}
