import OpenAI from "openai";

const MODEL_ID = "openai/gpt-oss-120b";

let cachedClient: OpenAI | null = null;

/**
 * Resolve Groq API key from GROQ_API_KEY environment variable.
 */
export function resolveGroqApiKey(): string | undefined {
	return process.env.GROQ_API_KEY;
}

function getClient(apiKey: string): OpenAI {
	if (cachedClient) return cachedClient;
	cachedClient = new OpenAI({
		apiKey,
		baseURL: "https://api.groq.com/openai/v1",
	});
	return cachedClient;
}

export type ClassifyResult = {
	workstream_id: string | null;
	new_workstream_name: string | null;
	is_work_message: boolean;
	reasoning: string;
};

export async function callGroqClassify(
	apiKey: string,
	prompt: string,
): Promise<ClassifyResult> {
	const client = getClient(apiKey);

	const response = await client.chat.completions.create({
		model: MODEL_ID,
		max_tokens: 1024,
		response_format: { type: "json_object" },
		messages: [
			{
				role: "user",
				content: prompt,
			},
		],
	});

	const text = response.choices[0]?.message?.content;

	if (!text) {
		console.error("[router] Groq response missing content");
		return { workstream_id: null, new_workstream_name: null, is_work_message: false, reasoning: "" };
	}

	let parsed: ClassifyResult;
	try {
		parsed = JSON.parse(text) as ClassifyResult;
	} catch (error) {
		console.error(
			`[router] Failed to parse Groq response as JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { workstream_id: null, new_workstream_name: null, is_work_message: false, reasoning: "" };
	}

	const result = {
		workstream_id: parsed.workstream_id || null,
		new_workstream_name: parsed.new_workstream_name || null,
		is_work_message: Boolean(parsed.is_work_message),
		reasoning: parsed.reasoning || "",
	};
	console.log("── [router] classification ──\n%s\n── [/router] ──", JSON.stringify(result, null, 2));
	return result;
}

/** Reset cached client (for testing or key rotation). */
export function resetGroqClient(): void {
	cachedClient = null;
}
