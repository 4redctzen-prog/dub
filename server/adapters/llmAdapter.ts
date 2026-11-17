import { getConfig } from '../config.ts';
import type {
  DubbingSettings,
  LanguageTranslationResult,
  SourceTranscription,
  TranscriptSegment,
  TranslatedSegment,
} from '../types.ts';

interface TranslationInput {
  sourceTranscription: SourceTranscription;
  sourceLanguageLabel: string;
  targetLanguageCode: string;
  targetLanguageName: string;
  settings: DubbingSettings;
}

function detectFormat(url: string, configured: 'openai' | 'anthropic' | 'gemini' | 'auto'): 'openai' | 'anthropic' | 'gemini' {
  if (configured !== 'auto') return configured;
  const lower = url.toLowerCase();
  if (lower.includes('/chat/completions') || lower.includes('/openai/')) return 'openai';
  if (lower.includes('anthropic.com') || lower.includes('/v1/messages')) return 'anthropic';
  if (lower.includes('generativelanguage.googleapis.com') || lower.includes(':generatecontent')) return 'gemini';
  return 'openai';
}

function extractJsonPayload(raw: string): unknown {
  const trimmed = raw.trim();
  // Strip optional markdown code fences
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // Attempt to locate outermost JSON object
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    }
    throw new Error('External LLM response was not valid JSON.');
  }
}

function parseLlmHttpJson<T>(bodyText: string, formatLabel: string): T {
  const trimmed = bodyText.trim();
  if (trimmed.startsWith('<')) {
    throw new Error(
      `External LLM endpoint (LLM_API_URL) returned an HTML page instead of JSON (${formatLabel}). Verify that LLM_API_URL points directly to the model API endpoint.`,
    );
  }
  try {
    return JSON.parse(bodyText) as T;
  } catch {
    throw new Error(`External LLM (${formatLabel}) returned invalid JSON: ${trimmed.slice(0, 200)}`);
  }
}

function sanitizeEndpointForError(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return rawUrl.split('?')[0];
  }
}

function resolveLlmUrl(rawUrl: string, model: string, format: 'openai' | 'anthropic' | 'gemini'): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (format === 'openai') {
    if (/\/(v1|openai|v1beta\/openai)$/i.test(trimmed)) {
      return `${trimmed}/chat/completions`;
    }
    return trimmed;
  }
  if (format === 'anthropic') {
    if (/\/v1$/i.test(trimmed)) {
      return `${trimmed}/messages`;
    }
    return trimmed;
  }
  // Gemini native REST endpoint
  if (!/:generatecontent$/i.test(trimmed)) {
    if (/\/models$/i.test(trimmed)) {
      return `${trimmed}/${encodeURIComponent(model)}:generateContent`;
    }
    if (/\/(v1|v1beta)$/i.test(trimmed)) {
      return `${trimmed}/models/${encodeURIComponent(model)}:generateContent`;
    }
    if (trimmed === 'https://generativelanguage.googleapis.com') {
      return `${trimmed}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    }
  }
  return trimmed;
}

function formatHttpError(status: number, url: string, model: string, bodyText: string): Error {
  const endpoint = sanitizeEndpointForError(url);
  const detail = bodyText.trim().slice(0, 350);
  if (status === 404) {
    return new Error(
      `External LLM (404 Not Found) at ${endpoint} for model "${model}". Check that LLM_API_URL is a valid API endpoint and LLM_MODEL is a valid model ID. ${detail}`,
    );
  }
  return new Error(`External LLM (${status}) at ${endpoint}: ${detail || 'Request failed.'}`);
}

async function callExternalLlm(systemPrompt: string, userPrompt: string): Promise<{ text: string; model: string }> {
  const cfg = getConfig();
  if (!cfg.llmApiUrl || !cfg.llmApiKey || !cfg.llmModel) {
    const missing: string[] = [];
    if (!cfg.llmApiUrl) missing.push('LLM_API_URL');
    if (!cfg.llmApiKey) missing.push('LLM_API_KEY');
    if (!cfg.llmModel) missing.push('LLM_MODEL');
    throw new Error(
      `External LLM integration is not configured. Missing environment variable(s): ${missing.join(', ')}.`,
    );
  }

  const format = detectFormat(cfg.llmApiUrl, cfg.llmRequestFormat);
  const targetUrl = resolveLlmUrl(cfg.llmApiUrl, cfg.llmModel, format);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  try {
    if (format === 'anthropic') {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.llmApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: cfg.llmModel,
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
        signal: controller.signal,
      });

      const bodyText = await response.text();
      if (!response.ok) {
        throw formatHttpError(response.status, targetUrl, cfg.llmModel, bodyText);
      }
      const parsed = parseLlmHttpJson<{ content?: Array<{ type?: string; text?: string }> }>(
        bodyText,
        'Anthropic format',
      );
      const text = parsed.content?.find((c) => c.type === 'text')?.text ?? parsed.content?.[0]?.text;
      if (!text) throw new Error('External LLM (Anthropic format) returned an empty text payload.');
      return { text, model: cfg.llmModel };
    }

    if (format === 'gemini') {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': cfg.llmApiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
          },
        }),
        signal: controller.signal,
      });

      const bodyText = await response.text();
      if (!response.ok) {
        throw formatHttpError(response.status, targetUrl, cfg.llmModel, bodyText);
      }
      const parsed = parseLlmHttpJson<{
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      }>(bodyText, 'Gemini format');
      const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('External LLM (Gemini format) returned an empty text payload.');
      return { text, model: cfg.llmModel };
    }

    // Default: OpenAI-compatible Chat Completions endpoint
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.llmApiKey}`,
      },
      body: JSON.stringify({
        model: cfg.llmModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw formatHttpError(response.status, targetUrl, cfg.llmModel, bodyText);
    }

    const parsed = parseLlmHttpJson<{
      choices?: Array<{ message?: { content?: string }; text?: string }>;
      output_text?: string;
    }>(bodyText, 'OpenAI-compatible format');
    const text =
      parsed.choices?.[0]?.message?.content ??
      parsed.choices?.[0]?.text ??
      parsed.output_text;

    if (!text) {
      throw new Error('External LLM returned an unexpected response format without message content.');
    }
    return { text, model: cfg.llmModel };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('External LLM request timed out after 90 seconds.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function translateWithExternalLlm(
  input: TranslationInput,
): Promise<LanguageTranslationResult> {
  const { sourceTranscription, sourceLanguageLabel, targetLanguageCode, targetLanguageName, settings } = input;

  const preservationInstructions: string[] = [];
  if (settings.preserveSpeakerIdentity) preservationInstructions.push('speaker persona and register');
  if (settings.preserveNarrationStyle) preservationInstructions.push('narration style and rhetorical cadence');
  if (settings.preserveEmotionalExpression) preservationInstructions.push('emotional nuance and tone');
  if (settings.preserveRhythmAndPacing) {
    preservationInstructions.push('spoken duration and syllable pacing so each segment fits its time window naturally');
  }

  const segmentsForPrompt =
    sourceTranscription.segments.length > 0
      ? sourceTranscription.segments
      : [
          {
            id: 'seg_0',
            speakerId: 'speaker_0',
            start: 0,
            end: 10,
            text: sourceTranscription.text,
          } satisfies TranscriptSegment,
        ];

  const systemPrompt = [
    'You are an expert audiovisual dubbing localization translator.',
    `Translate the spoken transcript from ${sourceLanguageLabel} into ${targetLanguageName} (${targetLanguageCode}).`,
    `Preserve: ${preservationInstructions.join(', ') || 'natural spoken delivery'}.`,
    'Produce natural, idiomatic spoken phrasing suitable for voice acting—never literal word-for-word machine translation.',
    'Keep punctuation accurate for natural breathing pauses.',
    `You MUST include an entry in "segments" for EVERY input segment ID (${segmentsForPrompt.length} segments total, preserving each "id" verbatim).`,
    'Return ONLY valid JSON matching this exact schema with no extra wrapper text:',
    '{"segments":[{"id":"seg_0","translatedText":"<natural spoken translation>"}],"fullTranslation":"<complete translated script>"}',
  ].join('\n');

  const userPayload = {
    sourceLanguage: sourceLanguageLabel,
    targetLanguage: `${targetLanguageName} (${targetLanguageCode})`,
    segments: segmentsForPrompt.map((s) => ({
      id: s.id,
      durationSec: Number((s.end - s.start).toFixed(2)),
      text: s.text,
    })),
  };

  const pickTranslatedField = (item: Record<string, unknown>): string => {
    const candidateKeys = [
      'translatedText',
      'translated_text',
      'translation',
      'targetText',
      'target_text',
      'dubbedText',
      'dubbed_text',
      'text',
      'content',
      'output',
    ];
    for (const key of candidateKeys) {
      const val = item[key];
      if (typeof val === 'string' && val.trim().length > 0) {
        return val.trim();
      }
    }
    return '';
  };

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text, model } = await callExternalLlm(systemPrompt, JSON.stringify(userPayload));
      const parsed = extractJsonPayload(text) as Record<string, unknown>;

      const mapById = new Map<string, string>();
      let rawArray: Array<Record<string, unknown>> = [];

      if (Array.isArray(parsed.segments)) {
        rawArray = parsed.segments.filter(
          (item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'),
        );
        for (const item of rawArray) {
          const idVal = item.id ?? item.segmentId ?? item.segment_id;
          const translated = pickTranslatedField(item);
          if (typeof idVal === 'string' && idVal.trim() && translated) {
            mapById.set(idVal.trim(), translated);
          }
        }
      } else if (parsed.segments && typeof parsed.segments === 'object') {
        // Handle object map form: { "seg_0": "translated text", ... }
        for (const [k, v] of Object.entries(parsed.segments as Record<string, unknown>)) {
          if (typeof v === 'string' && v.trim()) {
            mapById.set(k.trim(), v.trim());
          } else if (v && typeof v === 'object') {
            const translated = pickTranslatedField(v as Record<string, unknown>);
            if (translated) mapById.set(k.trim(), translated);
          }
        }
      }

      const fullTranslationRaw =
        (typeof parsed.fullTranslation === 'string' && parsed.fullTranslation.trim()) ||
        (typeof parsed.full_translation === 'string' && parsed.full_translation.trim()) ||
        (typeof parsed.translation === 'string' && parsed.translation.trim()) ||
        '';

      if (mapById.size === 0 && rawArray.length === 0 && !fullTranslationRaw) {
        const keysFound = Object.keys(parsed).join(', ') || 'none';
        throw new Error(`External LLM JSON did not include translated segments (top-level keys: ${keysFound}).`);
      }

      const translatedSegments: TranslatedSegment[] = [];
      for (let idx = 0; idx < segmentsForPrompt.length; idx++) {
        const seg = segmentsForPrompt[idx];
        const byId = mapById.get(seg.id);
        const byIndex = rawArray[idx] ? pickTranslatedField(rawArray[idx]) : '';
        const translatedText = byId ?? byIndex;

        if (translatedText) {
          translatedSegments.push({
            id: seg.id,
            start: seg.start,
            end: seg.end,
            sourceText: seg.text,
            translatedText,
          });
        } else if (translatedSegments.length > 0 && seg.end - seg.start < 0.6) {
          // Very short trailing/merged fragment absorbed by the LLM into the preceding segment; skip cleanly
          continue;
        } else if (idx === 0 && fullTranslationRaw && rawArray.length === 0 && mapById.size === 0) {
          // LLM returned a single fullTranslation string without per-segment array
          translatedSegments.push({
            id: 'seg_0',
            start: segmentsForPrompt[0].start,
            end: segmentsForPrompt[segmentsForPrompt.length - 1].end,
            sourceText: sourceTranscription.text,
            translatedText: fullTranslationRaw,
          });
          break;
        } else {
          const sampleKeys = rawArray[0] ? Object.keys(rawArray[0]).join(', ') : 'none';
          throw new Error(
            `External LLM omitted translation for segment ${seg.id} (received ${rawArray.length} segments; first item keys: ${sampleKeys}).`,
          );
        }
      }

      const fullTranslatedText =
        fullTranslationRaw || translatedSegments.map((s) => s.translatedText).join(' ');

      return {
        targetLanguageCode,
        targetLanguageName,
        fullTranslatedText,
        segments: translatedSegments,
        llmModel: model,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error('External LLM translation failed.');
}
