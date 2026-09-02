// Unit tests for workflow graph validation and condition predicates
// (lib/workflow-runner.ts) — the pure functions behind the workflow
// editor's save path and the condition-node branching at run time.
//
// The full execute() path needs harnesses + DB; these tests pin the
// validation contract the API enforces on every workflow PUT.

import { describe, test, expect } from "bun:test";
import { validateGraph, matchPredicate, normaliseGraph } from "./workflow-runner.ts";
import type { WorkflowGraph } from "./workflow-runner.ts";
import type { Predicate } from "./watches.ts";

const validGraph: WorkflowGraph = {
  nodes: [
    { id: "t1", kind: "trigger", label: "Manual", x: 0, y: 0, config: {} },
    { id: "a1", kind: "agent_run", label: "Summarize", x: 300, y: 0, config: {} },
  ],
  edges: [{ id: "e1", source: "t1", target: "a1" }],
};

describe("validateGraph", () => {
  test("accepts a valid trigger → agent graph", () => {
    expect(validateGraph(validGraph)).toBeNull();
  });

  test("rejects non-object graphs", () => {
    expect(validateGraph(null)).toBe("graph must be an object");
    expect(validateGraph("nodes")).toBe("graph must be an object");
    expect(validateGraph(42)).toBe("graph must be an object");
  });

  test("requires nodes and edges arrays", () => {
    expect(validateGraph({})).toBe("graph.nodes must be an array");
    expect(validateGraph({ nodes: [] })).toBe("graph.edges must be an array");
    expect(validateGraph({ nodes: [], edges: "nope" })).toBe("graph.edges must be an array");
  });

  test("every node needs a non-empty id", () => {
    const bad = { nodes: [{ kind: "trigger", config: {} }], edges: [] };
    expect(validateGraph(bad)).toBe("every node needs an id");
  });

  test("rejects unknown node kinds", () => {
    const bad = {
      nodes: [{ id: "x1", kind: "rm_rf_root", config: {} }],
      edges: [],
    };
    expect(validateGraph(bad)).toBe("node x1: unknown kind rm_rf_root");
  });

  test("rejects duplicate node ids", () => {
    const bad = {
      nodes: [
        { id: "t1", kind: "trigger", config: {} },
        { id: "t1", kind: "trigger", config: {} },
      ],
      edges: [],
    };
    expect(validateGraph(bad)).toBe("duplicate node id: t1");
  });

  test("edges must reference existing nodes", () => {
    const bad = {
      nodes: [{ id: "t1", kind: "trigger", config: {} }],
      edges: [{ id: "e1", source: "t1", target: "ghost" }],
    };
    expect(validateGraph(bad)).toBe("edge e1: target ghost not in nodes");
    expect(validateGraph({ nodes: [], edges: [{ id: "e1", source: "ghost", target: "t1" }] })).toBe(
      "edge e1: source ghost not in nodes"
    );
  });

  test("edges need source and target", () => {
    const bad = { nodes: [], edges: [{ id: "e1", source: "", target: "" }] };
    expect(validateGraph(bad)).toBe("edge e1: source and target required");
  });
});

describe("matchPredicate (condition branching)", () => {
  const payload = {
    status: 200,
    body: { text: "hello world" },
    node: { ok: true, over: 42, name: "agent-1" },
  };

  test("empty clause matches everything", () => {
    expect(matchPredicate([], payload)).toBe(true);
  });

  test("eq on nested paths", () => {
    expect(matchPredicate([{ path: "node.ok", op: "eq", value: true }], payload)).toBe(true);
    expect(matchPredicate([{ path: "node.ok", op: "eq", value: false }], payload)).toBe(false);
  });

  test("neq", () => {
    expect(matchPredicate([{ path: "status", op: "neq", value: 500 }], payload)).toBe(true);
    expect(matchPredicate([{ path: "status", op: "neq", value: 200 }], payload)).toBe(false);
  });

  test("gt / lt numeric comparisons", () => {
    expect(matchPredicate([{ path: "node.over", op: "gt", value: 10 }], payload)).toBe(true);
    expect(matchPredicate([{ path: "node.over", op: "gt", value: 100 }], payload)).toBe(false);
    expect(matchPredicate([{ path: "node.over", op: "lt", value: 100 }], payload)).toBe(true);
    expect(matchPredicate([{ path: "node.over", op: "lt", value: 10 }], payload)).toBe(false);
  });

  test("gt/lt reject non-numeric operands (no JS coercion)", () => {
    expect(matchPredicate([{ path: "node.name", op: "gt", value: 0 }], payload)).toBe(false);
    expect(
      matchPredicate([{ path: "node.over", op: "gt", value: "10" as unknown as number }], payload)
    ).toBe(false);
  });

  test("contains on strings", () => {
    expect(matchPredicate([{ path: "body.text", op: "contains", value: "hello" }], payload)).toBe(
      true
    );
    expect(matchPredicate([{ path: "body.text", op: "contains", value: "goodbye" }], payload)).toBe(
      false
    );
  });

  test("exists", () => {
    expect(matchPredicate([{ path: "node.name", op: "exists", value: null }], payload)).toBe(true);
    expect(matchPredicate([{ path: "node.ghost", op: "exists", value: null }], payload)).toBe(
      false
    );
  });

  test("all clauses must hold (AND semantics)", () => {
    const clause: Predicate[] = [
      { op: "eq", path: "status", value: 200 },
      { op: "eq", path: "node.ok", value: true },
    ];
    expect(matchPredicate(clause, payload)).toBe(true);
    expect(matchPredicate([...clause, { op: "eq", path: "status", value: 404 }], payload)).toBe(
      false
    );
  });
});

describe("normaliseGraph (defensive shaping)", () => {
  test("returns empty graph for garbage input", () => {
    expect(normaliseGraph(null)).toEqual({ nodes: [], edges: [] });
    expect(normaliseGraph("x")).toEqual({ nodes: [], edges: [] });
  });

  test("passes through a well-formed graph", () => {
    expect(normaliseGraph(validGraph)).toEqual(validGraph);
  });
});
