import { Hono } from "hono";
import { cdpPaymentMiddleware } from "x402-cdp";
import { describeRoute, openAPIRouteHandler } from "hono-openapi";

const app = new Hono<{ Bindings: Env }>();

const MODELS = {
  flux: "@cf/black-forest-labs/FLUX.1-schnell",
  sd: "@cf/stabilityai/stable-diffusion-xl-base-1.0",
} as const;

app.get("/.well-known/openapi.json", openAPIRouteHandler(app, {
  documentation: {
    info: {
      title: "x402 Image Generation Service",
      description: "Generate images from text prompts using AI (FLUX.1 or Stable Diffusion XL). Pay-per-use via x402 protocol on Base mainnet.",
      version: "1.0.0",
    },
    servers: [{ url: "https://imagegen.camelai.io" }],
  },
}));

app.use(
  cdpPaymentMiddleware(
    (env) => ({
      "POST /generate": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.02",
            network: "eip155:8453",
            payTo: env.SERVER_ADDRESS as `0x${string}`,
          },
        ],
        description: "Generate an image from a text prompt using AI",
        mimeType: "image/png",
        extensions: {
          bazaar: {
            discoverable: true,
            inputSchema: {
              body: {
                prompt: {
                  type: "string",
                  description: "Text prompt describing the image to generate",
                  required: true,
                },
                model: {
                  type: "string",
                  description: "Model to use: 'flux' (fast, default) or 'sd' (SDXL)",
                  required: false,
                },
                steps: {
                  type: "number",
                  description: "Number of inference steps (default 4)",
                  required: false,
                },
                width: {
                  type: "number",
                  description: "Image width in pixels",
                  required: false,
                },
                height: {
                  type: "number",
                  description: "Image height in pixels",
                  required: false,
                },
              },
            },
          },
        },
      },
    })
  )
);

app.post("/generate", describeRoute({
  description: "Generate an image from a text prompt using AI. Requires x402 payment ($0.02).",
  requestBody: {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["prompt"],
          properties: {
            prompt: { type: "string", description: "Text prompt describing the image to generate" },
            model: { type: "string", enum: ["flux", "sd"], default: "flux", description: "Model: 'flux' (fast) or 'sd' (SDXL)" },
            steps: { type: "integer", default: 4, description: "Number of inference steps" },
            width: { type: "integer", description: "Image width in pixels" },
            height: { type: "integer", description: "Image height in pixels" },
          },
        },
      },
    },
  },
  responses: {
    200: { description: "Generated PNG image", content: { "image/png": { schema: { type: "string", format: "binary" } } } },
    400: { description: "Invalid request body" },
    402: { description: "Payment required" },
    500: { description: "Image generation failed" },
  },
}), async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const prompt = body.prompt as string | undefined;
  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
    return c.json({ error: "Missing required field: prompt" }, 400);
  }

  const modelKey = ((body.model as string) || "flux").toLowerCase();
  if (modelKey !== "flux" && modelKey !== "sd") {
    return c.json({ error: "Model must be 'flux' or 'sd'" }, 400);
  }

  const model = MODELS[modelKey];
  const steps = typeof body.steps === "number" ? body.steps : 4;

  try {
    const input: Record<string, unknown> = {
      prompt: prompt.trim(),
      num_steps: steps,
    };

    if (typeof body.width === "number") input.width = body.width;
    if (typeof body.height === "number") input.height = body.height;

    const result = await c.env.AI.run(model as Parameters<Ai["run"]>[0], input as never);

    // Workers AI image models return a ReadableStream of PNG data
    return new Response(result as ReadableStream, {
      headers: {
        "Content-Type": "image/png",
        "Content-Disposition": 'inline; filename="generated.png"',
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: "Image generation failed", details: message }, 500);
  }
});

export default app;
