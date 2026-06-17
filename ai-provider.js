const { execFile } = require('child_process');
const path = require('path');

// System prompts for each AI action
const SYSTEM_PROMPTS = {
    review: 'You are a writing assistant. Review the following message for grammar, spelling, and clarity errors. Return the corrected version first, then on a new line starting with "Changes:" briefly note what was changed. If the message is already correct, return it as-is and say "No changes needed."',
    translate: 'You are a translator. Translate the following text to {targetLanguage}. Return only the translation, nothing else.',
    reply: 'You are a messaging assistant. Based on the following message, suggest a natural, friendly reply. Keep it concise and conversational. Return only the suggested reply.',
    summarize: 'You are a summarization assistant. Summarize the following messages or conversation concisely, highlighting key points. Use bullet points if there are multiple topics.'
};

function buildPrompt(action, text, options = {}) {
    let systemPrompt = SYSTEM_PROMPTS[action] || SYSTEM_PROMPTS.review;
    if (action === 'translate') {
        const lang = options.targetLanguage || 'English';
        systemPrompt = systemPrompt.replace('{targetLanguage}', lang);
    }
    return { systemPrompt, userMessage: text };
}

// Claude CLI Provider - uses locally installed claude CLI, no API key needed
class ClaudeCLIProvider {
    constructor(settings = {}) {
        this.cliPath = settings.claudeCliPath || 'claude';
    }

    async sendRequest(action, text, options = {}) {
        const { systemPrompt, userMessage } = buildPrompt(action, text, options);
        const fullPrompt = `${systemPrompt}\n\nText:\n${userMessage}`;

        return new Promise((resolve, reject) => {
            const args = ['--print', '-p', fullPrompt];

            execFile(this.cliPath, args, {
                timeout: 60000,
                maxBuffer: 1024 * 1024,
                env: { ...process.env }
            }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`Claude CLI error: ${error.message}`));
                    return;
                }
                resolve(stdout.trim());
            });
        });
    }
}

// Claude API Provider - uses Anthropic Messages API
class ClaudeAPIProvider {
    constructor(settings = {}) {
        this.apiKey = settings.claudeApiKey || '';
        this.model = settings.claudeModel || 'claude-sonnet-4-6-20250514';
    }

    async sendRequest(action, text, options = {}) {
        if (!this.apiKey) {
            throw new Error('Claude API key is not configured. Please set it in AI Settings.');
        }

        const { systemPrompt, userMessage } = buildPrompt(action, text, options);

        const body = JSON.stringify({
            model: this.model,
            max_tokens: 1024,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }]
        });

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01'
            },
            body
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`Claude API error (${response.status}): ${errorData.error?.message || response.statusText}`);
        }

        const data = await response.json();
        return data.content?.[0]?.text || '';
    }
}

// OpenAI API Provider
class OpenAIAPIProvider {
    constructor(settings = {}) {
        this.apiKey = settings.openaiApiKey || '';
        this.model = settings.openaiModel || 'gpt-4o';
    }

    async sendRequest(action, text, options = {}) {
        if (!this.apiKey) {
            throw new Error('OpenAI API key is not configured. Please set it in AI Settings.');
        }

        const { systemPrompt, userMessage } = buildPrompt(action, text, options);

        const body = JSON.stringify({
            model: this.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            max_tokens: 1024
        });

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`OpenAI API error (${response.status}): ${errorData.error?.message || response.statusText}`);
        }

        const data = await response.json();
        return data.choices?.[0]?.message?.content || '';
    }
}

// OpenRouter Provider - OpenAI-compatible API gateway to many models
// (Anthropic, OpenAI, Google, Meta, etc.) under a single key.
class OpenRouterProvider {
    constructor(settings = {}) {
        this.apiKey = settings.openrouterApiKey || '';
        this.model = settings.openrouterModel || 'openai/gpt-4o';
    }

    async sendRequest(action, text, options = {}) {
        if (!this.apiKey) {
            throw new Error('OpenRouter API key is not configured. Please set it in AI Settings.');
        }

        const { systemPrompt, userMessage } = buildPrompt(action, text, options);

        const body = JSON.stringify({
            model: this.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userMessage }
            ],
            max_tokens: 1024
        });

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
                // Optional attribution headers recommended by OpenRouter.
                'HTTP-Referer': 'https://github.com/multi-browser',
                'X-Title': 'Multi Browser'
            },
            body
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`OpenRouter API error (${response.status}): ${errorData.error?.message || response.statusText}`);
        }

        const data = await response.json();
        return data.choices?.[0]?.message?.content || '';
    }
}

// Factory function to create the right provider based on settings
function createProvider(settings = {}) {
    const provider = settings.provider || 'claude-cli';

    switch (provider) {
        case 'claude-cli':
            return new ClaudeCLIProvider(settings);
        case 'claude-api':
            return new ClaudeAPIProvider(settings);
        case 'openai-api':
            return new OpenAIAPIProvider(settings);
        case 'openrouter-api':
            return new OpenRouterProvider(settings);
        default:
            return new ClaudeCLIProvider(settings);
    }
}

module.exports = { createProvider, ClaudeCLIProvider, ClaudeAPIProvider, OpenAIAPIProvider, OpenRouterProvider };
