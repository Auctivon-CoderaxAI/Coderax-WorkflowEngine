import type { CreativeArtifact, CreativeFormat, CreativeValidation } from '@coderax/contracts';
import { CREATIVE_MAX_ARTIFACTS } from '@coderax/contracts';
import { validateCreative } from './validate.js';

/**
 * Creative output is extracted from agent text and validated before it becomes a
 * renderable artifact. The same validator is exposed as an operation so a client
 * can check a draft without running a task. Extraction is bounded: at most four
 * fenced blocks, each under the configured byte ceiling.
 */

export type CreativeService = {
  validate: (input: {
    format: CreativeFormat;
    content: string;
  }) => CreativeValidation;
  extract: (text: string) => CreativeArtifact[];
};

const FENCE = /```(svg|html)[ \t]*\r?\n([\s\S]*?)```/gi;

export function createCreativeService(input: { maxBytes: number }): CreativeService {
  const validate: CreativeService['validate'] = ({ format, content }) =>
    validateCreative({ format, content, maxBytes: input.maxBytes });

  return {
    validate,
    extract: (text) => {
      const artifacts: CreativeArtifact[] = [];
      const seen = new Set<string>();
      FENCE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while (
        (match = FENCE.exec(text)) !== null &&
        artifacts.length < CREATIVE_MAX_ARTIFACTS
      ) {
        const format = match[1]?.toLowerCase() as CreativeFormat;
        // The newline before a closing fence is Markdown structure, not part of
        // the document; normalizing it keeps the digest and the body stable.
        const content = (match[2] ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
        if (content.length === 0) continue;
        const validation = validate({ format, content });
        if (seen.has(validation.sha256)) continue;
        seen.add(validation.sha256);
        artifacts.push({
          artifactId: `creative_${validation.sha256.slice(0, 24)}`,
          format,
          safe: validation.safe,
          ...(validation.safe ? { content } : {}),
          sha256: validation.sha256,
          bytes: validation.bytes,
          findings: validation.findings,
        });
      }
      return artifacts;
    },
  };
}
