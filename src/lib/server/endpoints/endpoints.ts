import type { Conversation } from "$lib/types/Conversation";
import type { Message } from "$lib/types/Message";
import { z } from "zod";
import { endpointOAIParametersSchema, endpointOai } from "./openai/endpointOai";
import type { BackendModel } from "$lib/server/models";
import type { ObjectId } from "mongodb";

export type EndpointMessage = Omit<Message, "id">;

// parameters passed when generating text
export interface EndpointParameters {
	messages: EndpointMessage[];
	preprompt?: Conversation["preprompt"];
	generateSettings?: Partial<BackendModel["parameters"]>;
	isMultimodal?: boolean;
	conversationId?: ObjectId;
	locals: App.Locals | undefined;
	abortSignal?: AbortSignal;
	/** Optional thinking-effort, forwarded as OpenAI `reasoning_effort` when set */
	reasoningEffort?: "low" | "medium" | "high";
	/** Per-model user override for reasoning; wins over the model's supportsReasoning flag in both directions */
	reasoningOverride?: boolean;
}

/** One token of a streamed generation. */
export interface TextGenerationStreamToken {
	id: number;
	logprob: number;
	special: boolean;
	text: string;
	[property: string]: unknown;
}

/** One chunk of a streamed generation, in the shape the endpoints emit. */
export interface TextGenerationStreamOutput {
	details?: null | {
		finish_reason: "length" | "eos_token" | "stop_sequence";
		generated_tokens: number;
		input_length: number;
		seed?: number;
		[property: string]: unknown;
	};
	generated_text?: string | null;
	index?: number;
	token: TextGenerationStreamToken;
	top_tokens?: TextGenerationStreamToken[];
	[property: string]: unknown;
}

export type TextGenerationStreamOutputSimplified = TextGenerationStreamOutput & {
	token: TextGenerationStreamToken;
	routerMetadata?: { route?: string; model?: string; provider?: string };
};
// type signature for the endpoint
export type Endpoint = (
	params: EndpointParameters
) => Promise<AsyncGenerator<TextGenerationStreamOutputSimplified, void, void>>;

// list of all endpoint generators
export const endpoints = {
	openai: endpointOai,
};

export const endpointSchema = z.discriminatedUnion("type", [endpointOAIParametersSchema]);
export default endpoints;
