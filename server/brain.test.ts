// Tests for parseAnswer — the line-oriented format that replaced the JSON envelope.
// Everything downstream (teleprompter, progressive speech, the code slab) reads its output, and
// the model is free-form text, so the parser has to survive the model being sloppy.
import { describe, expect, test } from "bun:test";
import { parseAnswer } from "./brain";

describe("parseAnswer", () => {
  test("cue on line 1, points, no code", () => {
    const r = parseAnswer(`Lideré la migración a Kubernetes de 48 servicios sin caída de servicio.
- 48 servicios, cero downtime
- Rollback ensayado antes del corte`);
    expect(r.cue).toBe("Lideré la migración a Kubernetes de 48 servicios sin caída de servicio.");
    expect(r.points).toEqual(["48 servicios, cero downtime", "Rollback ensayado antes del corte"]);
    expect(r.code).toBeNull();
  });

  test("fenced code is extracted and kept out of the points", () => {
    const r = parseAnswer(`Ordeno por inicio y recorro una vez fusionando solapes.
- O(n log n) por el orden
\`\`\`python
def merge(iv):
    return sorted(iv)
\`\`\``);
    expect(r.cue).toStartWith("Ordeno por inicio");
    expect(r.points).toEqual(["O(n log n) por el orden"]);
    expect(r.code?.lang).toBe("python");
    expect(r.code?.body).toContain("def merge(iv):");
    expect(r.code?.body).not.toContain("```");
  });

  test("an unterminated fence still yields the code (the stream can be cut short)", () => {
    const r = parseAnswer(`Uso un diccionario más una lista doblemente enlazada.
\`\`\`python
class LRU:
    pass`);
    expect(r.code?.body).toContain("class LRU:");
  });

  test("a fence with no language tag falls back to text", () => {
    const r = parseAnswer("Aquí va.\n```\nx = 1\n```");
    expect(r.code).toEqual({ lang: "text", body: "x = 1" });
  });

  test("(nada) means the turn needed no answer", () => {
    for (const s of ["(nada)", "nada", "(nada).", "(nothing)"]) expect(parseAnswer(s).cue).toBe("");
  });

  test("surrounding quotes are stripped — models add them despite being told not to", () => {
    expect(parseAnswer('"Sí, lo llevé a producción."').cue).toBe("Sí, lo llevé a producción.");
    expect(parseAnswer("`Sí, lo llevé a producción.`").cue).toBe("Sí, lo llevé a producción.");
  });

  test("accepts -, • and * as bullets, and caps at six", () => {
    const r = parseAnswer(["cue", ...Array.from({ length: 9 }, (_, i) => `${["-", "•", "*"][i % 3]} p${i}`)].join("\n"));
    expect(r.points).toHaveLength(6);
    expect(r.points[0]).toBe("p0");
    expect(r.points[2]).toBe("p2");
  });

  test("a line that merely contains a dash is not a bullet", () => {
    const r = parseAnswer("cue\nesto no es viñeta - solo lleva un guion\n- esta sí");
    expect(r.points).toEqual(["esta sí"]);
  });

  test("empty and whitespace-only input never throws", () => {
    for (const s of ["", "   ", "\n\n"]) {
      const r = parseAnswer(s);
      expect(r.cue).toBe("");
      expect(r.points).toEqual([]);
      expect(r.code).toBeNull();
    }
  });

  test("a partial first line still parses — this is what streaming hands us mid-flight", () => {
    const r = parseAnswer("Lideré la migración a Kub");
    expect(r.cue).toBe("Lideré la migración a Kub");
    expect(r.code).toBeNull();
  });

  test("an empty fence is not reported as code", () => {
    expect(parseAnswer("cue\n```python\n\n```").code).toBeNull();
  });
});
