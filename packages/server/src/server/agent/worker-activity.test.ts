import { expect, test } from "vitest";
import { countRunningWorkers } from "./worker-activity.js";

test("counts running child agents per configured provider, not supervisors or idle children", () => {
  expect(
    countRunningWorkers([
      { provider: "pi", lifecycle: "running", parentId: "supervisor" },
      { provider: "pi", lifecycle: "running", parentId: "another-supervisor" },
      { provider: "pi", lifecycle: "idle", parentId: "supervisor" },
      { provider: "pi", lifecycle: "running", parentId: undefined },
      { provider: "pi-other", lifecycle: "running", parentId: "supervisor" },
      { provider: "pi-other", lifecycle: "initializing", parentId: "supervisor" },
    ]),
  ).toEqual({ pi: 2, "pi-other": 1 });
  expect(countRunningWorkers([])).toEqual({});
  expect(
    countRunningWorkers([
      { provider: "pi", lifecycle: "idle", parentId: "supervisor", hasRun: true },
    ]),
  ).toEqual({ pi: 1 });
});
