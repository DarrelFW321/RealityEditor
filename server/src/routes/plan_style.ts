import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config, missingKeyResponse } from "../config.js";
import { strictJsonSchema } from "../openai-json.js";
import { loadManifest, loadGeneratedEntries, filterByFreeSpace } from "../catalog.js";
import { OpCoreSchema, type OpCore } from "../contracts.js";

/**
 * POST /plan_style — expands a theme into a batch of at most 12 ops.
 *
 * OFF THE CRITICAL PATH. 2-3 seconds is fine here; the UI covers it with a
 * "thinking" animation. This is the one place a slow, strong model is the right
 * call, and the only place in the product where a language model gets to make an
 * aesthetic decision.
 *
 * It returns OpCore, not Op. The envelope (op_id, seq, branch_id) and the
 * `inverse` are minted CLIENT-SIDE by Applier.apply, because only the device can
 * compute an inverse against the live graph. That keeps the promise that the
 * server is not in the op path — it proposes intent and nothing else.
 */

// ---------------------------------------------------------------- request

const ObjectSummarySchema = z.object({
  id: z.string(),
  class: z.string(),
  refined_class: z.string().nullable().optional(),
  dims_m: z.tuple([z.number(), z.number(), z.number()]),
  movable: z.boolean(),
});

const SurfaceSummarySchema = z.object({
  id: z.string(),
  class: z.string(),
  material_ref: z.string(),
});

const RequestSchema = z.object({
  room_id: z.string(),
  theme: z.string().min(1).max(120),
  area_m2: z.number().positive(),
  ceiling_height: z.number().positive(),
  /** From SCP.free_space_summary. Measured, not guessed — see the filter below. */
  largest_open_rect: z.object({
    center: z.tuple([z.number(), z.number()]),
    size: z.tuple([z.number(), z.number()]),
    yaw: z.number(),
  }),
  objects: z.array(ObjectSummarySchema).max(60),
  surfaces: z.array(SurfaceSummarySchema).max(60),
});

// ---------------------------------------------------------------- model output
//
// A narrow schema, deliberately not the generated OpCoreSchema. Two reasons:
// the generated schema's nullable-union fields are awkward for a strict
// structured-output format, and a style planner has no business emitting
// DELETE_OBJECT or MODIFY_WALL. What it CAN emit is enumerated here, and the
// result is validated against the real OpCoreSchema before it leaves this file —
// so the narrow schema constrains the model and the frozen contract still has
// the last word.

const PlannedOpSchema = z.object({
  type: z.enum(["CHANGE_MATERIAL", "CHANGE_COLOR", "REPLACE_OBJECT", "ADD_OBJECT", "MOVE_OBJECT"]),
  target_id: z.string().describe("An entity id from the room summary, verbatim. For ADD_OBJECT, a new id you invent starting with 'obj_'."),
  material_ref: z.string().nullable().describe("Material id from the palette. CHANGE_MATERIAL only."),
  color_hex: z.string().nullable().describe("#rrggbb. CHANGE_COLOR only."),
  catalog_id: z.string().nullable().describe("Catalog entry id. REPLACE_OBJECT and ADD_OBJECT only, and ONLY from the filtered list you were given."),
  relation: z.enum(["against_wall", "under", "on_top_of", "beside", "in_front_of", "centered_in", "facing"]).nullable().describe("Placement intent for ADD_OBJECT / MOVE_OBJECT. Never coordinates."),
  anchor_id: z.string().nullable().describe("Entity the relation is measured against."),
  rationale: z.string().max(140).describe("One clause, for the spoken summary."),
});

/** What actually comes back: same shape, no lengths, because strict mode drops them. */
const PlanWireSchema = z.object({
  summary: z.string(),
  ops: z.array(PlannedOpSchema.extend({ rationale: z.string() })),
});

const PlanSchema = z.object({
  summary: z.string().max(240).describe("One or two sentences, read aloud verbatim."),
  ops: z.array(PlannedOpSchema).max(config.planner.maxOps),
});

// ---------------------------------------------------------------- mapping

function toOpCore(p: z.infer<typeof PlannedOpSchema>): OpCore {
  // Every OpParams field, explicitly nulled. The generated schema has no
  // defaults, and a missing key is not the same as a null one to zod.
  const params = {
    anchor_id: p.anchor_id,
    catalog_id: p.catalog_id,
    color_hex: p.color_hex,
    dimensions: null,
    face_anchor_id: null,
    keep_pose: p.type === "REPLACE_OBJECT" ? true : null,
    material_ref: p.material_ref,
    object: null,
    offset_m: null,
    position: null,
    relation: p.relation,
    scale: null,
    side: null,
    style_batch_id: null as string | null,
    surface: null,
    surface_state: null,
    theme: null,
    undo_op_id: null,
    yaw: null,
    yaw_delta: null,
  };
  return { type: p.type, target_ids: [p.target_id], params } as OpCore;
}

export async function registerPlanStyleRoute(app: FastifyInstance) {
  app.post("/plan_style", async (request, reply) => {
    if (!config.openaiApiKey) {
      return reply.code(503).send(missingKeyResponse("OPENAI_API_KEY"));
    }

    const parsed = RequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", detail: parsed.error.format() });
    }
    const room = parsed.data;

    // THE HONESTY FILTER. The planner only ever sees furniture that fits the
    // measured free space, so it cannot pick a sectional the room cannot hold.
    // Enforced by the input, not by asking the model nicely in the prompt.
    const manifest = loadManifest();
    // Both catalogues: the shipped USDZ assets and anything generated. They are
    // separate files with separate schemas, and the planner should not care which
    // a given object came from — only whether it fits.
    const everything = [...manifest.entries, ...loadGeneratedEntries()];
    const fits = filterByFreeSpace(everything, room.largest_open_rect);

    const known = new Set<string>([
      ...room.objects.map((o) => o.id),
      ...room.surfaces.map((s) => s.id),
    ]);
    const catalogIDs = new Set(fits.map((e) => e.id));
    const materialIDs = new Set(manifest.materials.map((m) => m.id));

    const system = [
      "You are an interior designer working against a measured 3D scan of a real room.",
      "",
      "HARD RULES:",
      "- Use ONLY entity ids, catalog ids and material ids given below. Anything else is discarded.",
      "- The catalogue has already been filtered to what physically fits. Do not ask for more.",
      "- If the requested kind of furniture has no large option in that filtered list, choose a",
      "  smaller fitting option of the same class and say that substitution plainly in the summary.",
      "- Never emit coordinates, dimensions or distances. Express placement as relation + anchor;",
      "  the device's solver computes the pose against real geometry and may move it.",
      `- At most ${config.planner.maxOps} ops. Fewer and better beats more.`,
      "- Change materials and colours before you add objects. A repaint reads instantly on camera;",
      "  a new object has to be placed, solved, and can be rejected.",
      "- Do not touch anything with movable=false.",
    ].join("\n");

    let plan: z.infer<typeof PlanSchema> | null = null;
    try {
      const response = await fetch(config.planner.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.planner.model,
          // Held low, as the Anthropic call was: this is a taste call against a
          // constrained schema, not a reasoning problem, and every extra second
          // is animation the user watches instead of their room.
          reasoning_effort: config.planner.effort,
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content: JSON.stringify({
                theme: room.theme,
                room: {
                  area_m2: room.area_m2,
                  ceiling_height: room.ceiling_height,
                  largest_open_rect_m: room.largest_open_rect.size,
                },
                objects: room.objects,
                surfaces: room.surfaces,
                available_materials: manifest.materials,
                available_catalog_that_fits: fits.map((e) => ({
                  id: e.id, class: e.class, style_tags: e.style_tags, dims_m: e.dims_m,
                })),
              }),
            },
          ],
          // Shape is constrained here; CONTENT is still checked below, because a
          // schema cannot stop the model naming an id that does not exist.
          response_format: {
            type: "json_schema",
            json_schema: { name: "style_plan", strict: true, schema: strictJsonSchema(PlanSchema) },
          },
        }),
        // Off the critical path, but the user is watching an animation meanwhile.
        signal: AbortSignal.timeout(config.planner.timeoutMs),
      });
      if (!response.ok) {
        request.log.error({ status: response.status, body: (await response.text()).slice(0, 400) }, "style planner call failed");
        return reply.code(502).send({ error: "planner_failed" });
      }
      const completion = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      const content = completion.choices?.[0]?.message?.content;
      // Parsed WITHOUT the length limits, then clamped. Strict mode cannot carry
      // maxLength, so re-imposing it here would throw away a whole usable plan
      // over one long sentence. Truncating the summary is the lesser failure.
      const wire = content ? PlanWireSchema.safeParse(JSON.parse(content)) : null;
      if (wire && !wire.success) {
        request.log.error({ issues: wire.error.issues.slice(0, 5) }, "style planner output did not match the schema");
      }
      plan = wire?.success
        ? {
            summary: wire.data.summary.slice(0, 240),
            ops: wire.data.ops.slice(0, config.planner.maxOps).map((op) => ({
              ...op,
              rationale: op.rationale.slice(0, 140),
            })),
          }
        : null;
    } catch (err) {
      request.log.error({ err }, "style planner call failed");
      return reply.code(502).send({ error: "planner_failed" });
    }

    if (!plan) {
      return reply.code(502).send({ error: "planner_returned_unparseable_output" });
    }

    // Second gate. Structured output constrains SHAPE, never CONTENT — the model
    // can still name an id that does not exist. Drop those ops rather than let the
    // client discover them: an op referencing an unknown entity is dropped on
    // device anyway, and dropping it here keeps the batch count honest.
    const style_batch_id = `sty_${Date.now().toString(36)}`;
    const dropped: string[] = [];
    const ops: OpCore[] = [];

    for (const p of plan.ops) {
      if (p.type !== "ADD_OBJECT" && !known.has(p.target_id)) {
        dropped.push(`${p.type} -> unknown target ${p.target_id}`);
        continue;
      }
      if (p.anchor_id && !known.has(p.anchor_id)) {
        dropped.push(`${p.type} -> unknown anchor ${p.anchor_id}`);
        continue;
      }
      if (p.catalog_id && !catalogIDs.has(p.catalog_id)) {
        dropped.push(`${p.type} -> catalog id ${p.catalog_id} is not in the fitting set`);
        continue;
      }
      if (p.material_ref && !materialIDs.has(p.material_ref)) {
        dropped.push(`${p.type} -> unknown material ${p.material_ref}`);
        continue;
      }

      const core = toOpCore(p);
      core.params.style_batch_id = style_batch_id;

      // Final gate: the frozen contract has the last word.
      const valid = OpCoreSchema.safeParse(core);
      if (!valid.success) {
        dropped.push(`${p.type} -> failed OpCore validation`);
        continue;
      }
      ops.push(valid.data);
      if (ops.length >= config.planner.maxOps) break;
    }

    if (dropped.length) {
      request.log.warn({ dropped }, "style planner ops dropped");
    }

    return reply.send({
      style_batch_id,
      summary: plan.summary,
      ops,
      dropped_count: dropped.length,
      catalog_considered: fits.length,
      catalog_total: manifest.entries.length,
    });
  });
}
