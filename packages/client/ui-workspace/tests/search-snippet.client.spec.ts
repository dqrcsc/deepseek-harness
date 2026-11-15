/** Unit tests for search snippet query-token segmentation and highlight splitting. */

import { describe, expect, it } from 'vitest'
import { extractSearchHighlightTerms, splitSnippetHighlights } from '../src/client/search-snippet.ts'

describe('extractSearchHighlightTerms', () => {
  it('returns empty for blank queries and orders full phrase ahead of segmented subtokens', () => {
    expect(extractSearchHighlightTerms('')).toEqual([])
    expect(extractSearchHighlightTerms('   ')).toEqual([])
    const terms = extractSearchHighlightTerms('  Persistent   memory架构  ')
    expect(terms[0]).toBe('Persistent   memory架构')
    expect(terms).toContain('Persistent')
    expect(terms).toContain('memory')
    expect(terms).toContain('架构')
    // Single-letter ASCII noise words do not pollute subtoken highlights, while single CJK characters stay.
    expect(extractSearchHighlightTerms('a 树 x')).toEqual(['a 树 x', '树'])
    // Case-equivalent duplicates collapse to the first spelling seen.
    expect(extractSearchHighlightTerms('Token token TOKEN')).toEqual(['Token token TOKEN', 'Token'])
  })
})

describe('splitSnippetHighlights', () => {
  it('handles empty snippets, blank queries, non-matching snippets, regex metacharacters, and mixed CJK/Latin matches', () => {
    expect(splitSnippetHighlights('', 'needle')).toEqual([])
    expect(splitSnippetHighlights('plain text', '   ')).toEqual([{ text: 'plain text', match: false }])
    expect(splitSnippetHighlights('nothing related here', 'quantum')).toEqual([
      { text: 'nothing related here', match: false },
    ])
    expect(splitSnippetHighlights('call fn(a+b) [ok]', 'fn(a+b)')).toEqual([
      { text: 'call ', match: false },
      { text: 'fn(a+b)', match: true },
      { text: ' [ok]', match: false },
    ])
    expect(splitSnippetHighlights('prefix Memory 架构治理', 'memory 架构')).toEqual([
      { text: 'prefix ', match: false },
      { text: 'Memory 架构', match: true },
      { text: '治理', match: false },
    ])
    expect(splitSnippetHighlights('waterfall first and token later', 'waterfall token')).toEqual([
      { text: 'waterfall', match: true },
      { text: ' first and ', match: false },
      { text: 'token', match: true },
      { text: ' later', match: false },
    ])
    expect(splitSnippetHighlights('trailing needle', 'needle')).toEqual([
      { text: 'trailing ', match: false },
      { text: 'needle', match: true },
    ])
  })
})
