'use strict';

/**
 * LLM Client — SAP AI Core (primary) + Anthropic Claude (fallback)
 *
 * Priority order:
 *   1. SAP AI Core  — when AICORE_CLIENT_ID + AICORE_CLIENT_SECRET are set
 *   2. Anthropic    — when ANTHROPIC_API_KEY is set
 *   3. null         — caller falls back to heuristics
 *
 * SAP AI Core uses the OpenAI-compatible chat completions endpoint.
 * Set these environment variables to activate it:
 *   AICORE_CLIENT_ID       — from AI Core service key
 *   AICORE_CLIENT_SECRET   — from AI Core service key
 *   AICORE_TOKEN_URL       — XSUAA token URL from service key
 *   AICORE_API_URL         — e.g. https://api.ai.prod.us-east-1.aws.ml.hana.ondemand.com
 *   AICORE_DEPLOYMENT_ID   — deployment ID of the model to use
 *   AICORE_RESOURCE_GROUP  — default: "default"
 */

class LLMClient {

    constructor() {
        this._tokenCache = null;
        this._tokenExpiry = 0;
    }

    get provider() {
        if (process.env.AICORE_CLIENT_ID && process.env.AICORE_CLIENT_SECRET &&
            process.env.AICORE_TOKEN_URL && process.env.AICORE_API_URL &&
            process.env.AICORE_DEPLOYMENT_ID) {
            return 'aicore';
        }
        if (process.env.ANTHROPIC_API_KEY) {
            return 'anthropic';
        }
        return 'none';
    }

    /**
     * Send a chat completion request.
     * Returns the model's response text, or null if no LLM is configured.
     */
    async complete(systemPrompt, userPrompt, maxTokens = 800) {
        try {
            if (this.provider === 'aicore') {
                return await this._callAICore(systemPrompt, userPrompt, maxTokens);
            }
            if (this.provider === 'anthropic') {
                return await this._callAnthropic(systemPrompt, userPrompt, maxTokens);
            }
        } catch (err) {
            console.warn(`[LLMClient] ${this.provider} call failed: ${err.message} — using heuristics`);
        }
        return null;
    }

    // ─── SAP AI Core ──────────────────────────────────────────────────
    // AICORE_API_FORMAT=openai   → /chat/completions (gpt-4o, gpt-4.1, …)
    // AICORE_API_FORMAT=bedrock  → /invoke with Bedrock format (claude via AI Core)
    // AICORE_API_FORMAT=anthropic→ /messages with Anthropic format (legacy)
    async _callAICore(systemPrompt, userPrompt, maxTokens) {
        const token    = await this._getAICoreToken();
        const apiUrl   = process.env.AICORE_API_URL.replace(/\/$/, '');
        const deplId   = process.env.AICORE_DEPLOYMENT_ID;
        const resGroup = process.env.AICORE_RESOURCE_GROUP || 'default';
        const fmt      = (process.env.AICORE_API_FORMAT || 'openai').toLowerCase();

        const headers = {
            'Authorization'    : `Bearer ${token}`,
            'AI-Resource-Group': resGroup,
            'Content-Type'     : 'application/json',
        };
        const base = `${apiUrl}/v2/inference/deployments/${deplId}`;

        if (fmt === 'bedrock') {
            const response = await fetch(`${base}/invoke`, {
                method: 'POST', headers,
                body: JSON.stringify({
                    anthropic_version: 'bedrock-2023-05-31',
                    max_tokens: maxTokens,
                    temperature: 0.3,
                    system  : systemPrompt,
                    messages: [{ role: 'user', content: userPrompt }],
                }),
            });
            const data = await response.json();
            if (data.error) throw new Error(`AI Core: ${JSON.stringify(data.error)}`);
            return data.content[0].text;
        }

        if (fmt === 'anthropic') {
            const response = await fetch(`${base}/messages`, {
                method: 'POST', headers,
                body: JSON.stringify({
                    max_tokens: maxTokens,
                    temperature: 0.3,
                    system  : systemPrompt,
                    messages: [{ role: 'user', content: userPrompt }],
                }),
            });
            const data = await response.json();
            if (data.error) throw new Error(`AI Core: ${JSON.stringify(data.error)}`);
            return data.content[0].text;
        }

        // Default: OpenAI-compatible chat/completions (gpt-4o, gpt-4.1, …)
        const response = await fetch(`${base}/chat/completions`, {
            method: 'POST', headers,
            body: JSON.stringify({
                messages  : [
                    { role: 'system', content: systemPrompt },
                    { role: 'user',   content: userPrompt   },
                ],
                max_tokens : maxTokens,
                temperature: 0.3,
            }),
        });
        const data = await response.json();
        if (data.error) throw new Error(`AI Core: ${JSON.stringify(data.error)}`);
        return data.choices[0].message.content;
    }

    async _getAICoreToken() {
        if (this._tokenCache && Date.now() < this._tokenExpiry) return this._tokenCache;

        const tokenUrl = process.env.AICORE_TOKEN_URL.replace(/\/$/, '');
        const response = await fetch(`${tokenUrl}/oauth/token`, {
            method : 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body   : new URLSearchParams({
                grant_type   : 'client_credentials',
                client_id    : process.env.AICORE_CLIENT_ID,
                client_secret: process.env.AICORE_CLIENT_SECRET,
            }),
        });

        const data = await response.json();
        if (!data.access_token) throw new Error('AI Core token fetch failed: ' + JSON.stringify(data));

        this._tokenCache  = data.access_token;
        this._tokenExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
        return this._tokenCache;
    }

    // ─── Anthropic Claude (fallback) ─────────────────────────────────
    async _callAnthropic(systemPrompt, userPrompt, maxTokens) {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method : 'POST',
            headers: {
                'x-api-key'        : process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type'     : 'application/json',
            },
            body: JSON.stringify({
                model     : 'claude-haiku-4-5-20251001',
                max_tokens: maxTokens,
                system    : systemPrompt,
                messages  : [{ role: 'user', content: userPrompt }],
            }),
        });

        const data = await response.json();
        if (data.error) throw new Error(`Anthropic: ${data.error.message}`);
        return data.content[0].text;
    }

    /**
     * Parse a JSON object from LLM text (handles markdown fences).
     */
    parseJSON(text) {
        if (!text) return null;
        try {
            const match = text.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                          text.match(/(\{[\s\S]*\})/);
            return match ? JSON.parse(match[1] || match[0]) : JSON.parse(text);
        } catch {
            return null;
        }
    }
}

module.exports = new LLMClient();
