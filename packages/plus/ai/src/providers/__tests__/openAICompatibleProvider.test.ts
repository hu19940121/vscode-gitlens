import * as assert from 'assert';
import type { AIProviderContext } from '../context.js';
import { OpenAICompatibleProvider } from '../openAICompatibleProvider.js';

function createContext(models?: ReturnType<AIProviderContext['getProviderConfig']>['models']): AIProviderContext {
	return {
		fetch: () => Promise.reject(new Error('not used')),
		getApiKey: () => Promise.resolve(undefined),
		getProviderConfig: () => ({ enabled: true, models: models }),
		getOrPromptUrl: () => Promise.resolve(undefined),
	};
}

suite('OpenAICompatibleProvider', () => {
	test('uses configured models instead of the built-in OpenAI catalog', async () => {
		const provider = new OpenAICompatibleProvider(
			createContext([
				{
					id: 'company-code-model',
					name: 'Company Code Model',
					maxInputTokens: 64000,
					maxOutputTokens: 8000,
				},
			]),
		);

		const models = await provider.getModels();

		assert.strictEqual(models.length, 1);
		assert.strictEqual(models[0]?.id, 'company-code-model');
		assert.strictEqual(models[0]?.name, 'Company Code Model');
		assert.deepStrictEqual(models[0]?.maxTokens, { input: 64000, output: 8000 });
		assert.strictEqual(models[0]?.provider.id, 'openaicompatible');
	});

	test('applies defaults to minimally configured models', async () => {
		const provider = new OpenAICompatibleProvider(createContext([{ id: 'private-model' }]));

		const models = await provider.getModels();

		assert.strictEqual(models[0]?.name, 'private-model');
		assert.deepStrictEqual(models[0]?.maxTokens, { input: 128000, output: 16384 });
	});

	test('uses the built-in catalog when no custom models are configured', async () => {
		const provider = new OpenAICompatibleProvider(createContext([]));

		const models = await provider.getModels();

		assert.ok(models.length > 0);
		assert.ok(models.some(model => model.default));
	});
});
