import { Hono } from "hono";
import { cdpPaymentMiddleware } from "x402-cdp";
import { stripeApiKeyMiddleware } from "x402-stripe";
import { extractParams } from "x402-ai";
import { openapiFromMiddleware } from "x402-openapi";

const app = new Hono<{ Bindings: Env }>();

const MODELS = {
  "flux-schnell": "@cf/black-forest-labs/FLUX.1-schnell",
  "stable-diffusion-xl": "@cf/stabilityai/stable-diffusion-xl-base-1.0",
} as const;

const SYSTEM_PROMPT = `You are a parameter extractor for an image generation service.
Extract the following from the user's message and return JSON:
- "prompt": the text description of the image to generate (required)
- "model": either "stable-diffusion-xl" (default) or "flux-schnell". Default "stable-diffusion-xl". (optional)
- "steps": number of inference steps, 1-20. Default 4. (optional)
- "width": image width in pixels. Default 1024. (optional)
- "height": image height in pixels. Default 1024. (optional)

Return ONLY valid JSON, no explanation.
Examples:
- {"prompt": "a sunset over mountains", "model": "flux-schnell", "steps": 4}
- {"prompt": "a cat wearing a hat", "model": "stable-diffusion-xl", "steps": 8, "width": 512, "height": 512}`;

const ROUTES = {
  "POST /": {
    accepts: [
      { scheme: "exact", price: "$0.02", network: "eip155:8453", payTo: "0x0" as `0x${string}` },
      { scheme: "exact", price: "$0.02", network: "eip155:137", payTo: "0x0" as `0x${string}` },
      { scheme: "exact", price: "$0.02", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: "CvraJ4avKPpJNLvMhMH5ip2ihdt85PXvDwfzXdziUxRq" },
    ],
    description: "Generate an image from a text prompt using AI. Send {\"input\": \"your prompt\"}",
    mimeType: "image/png",
    extensions: {
      bazaar: {
        info: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",
            body: {
              input: { type: "string", description: "Describe the image you want to generate, optionally specifying model, steps, width, height", required: true },
            },
          },
          output: { type: "raw" },
        },
        schema: {
          properties: {
            input: {
              properties: { method: { type: "string", enum: ["POST"] } },
              required: ["method"],
            },
          },
        },
      },
    },
  },
};

app.use(stripeApiKeyMiddleware({ serviceName: "image-gen" }));

app.use(async (c, next) => {
  if (c.get("skipX402")) return next();
  return cdpPaymentMiddleware((env) => ({
    "POST /": { ...ROUTES["POST /"], accepts: ROUTES["POST /"].accepts.map((a: any) => ({ ...a, payTo: a.network.startsWith("solana") ? a.payTo : env.SERVER_ADDRESS as `0x${string}` })) },
  }))(c, next);
});

app.post("/", async (c) => {
  const body = await c.req.json<{ input?: string }>();
  if (!body?.input) {
    return c.json({ error: "Missing 'input' field" }, 400);
  }

  const params = await extractParams(c.env.CF_GATEWAY_TOKEN, SYSTEM_PROMPT, body.input);

  const prompt = params.prompt as string | undefined;
  if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
    return c.json({ error: "Could not extract a prompt from your input" }, 400);
  }

  const modelKey = ((params.model as string) || "flux-schnell").toLowerCase();
  if (modelKey !== "flux-schnell" && modelKey !== "stable-diffusion-xl") {
    return c.json({ error: "Model must be 'flux-schnell' or 'stable-diffusion-xl'" }, 400);
  }

  const model = MODELS[modelKey];
  const steps = typeof params.steps === "number" ? Math.min(Math.max(params.steps, 1), 20) : 4;
  const width = typeof params.width === "number" ? params.width : 1024;
  const height = typeof params.height === "number" ? params.height : 1024;

  try {
    const input: Record<string, unknown> = {
      prompt: prompt.trim(),
      num_steps: steps,
    };

    if (width !== 1024) input.width = width;
    if (height !== 1024) input.height = height;

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

app.get("/.well-known/openapi.json", openapiFromMiddleware("x402 Image Gen", "imagegen.camelai.io", ROUTES));

app.get("/", (c) => {
  return new Response('# imagegen.camelai.io \\u2014 Image Gen\n\nGenerate images from text prompts.\n\nPart of [camelai.io](https://camelai.io).\n\n## API\n\n\\`POST /\\` \\u2014 $0.01 per request\n\n**Body:** `{"input": "a sunset over mountains in watercolor style"}`\n\n**Response:** PNG image\n\n## Payment\n\nAccepts USDC on Base, Polygon, or Solana via x402. Or use a Stripe API key (\\`Authorization: Bearer sk_camel_...\\`).\n\nSee [camelai.io](https://camelai.io) for payment setup and full service list.', {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
});

export default app;
