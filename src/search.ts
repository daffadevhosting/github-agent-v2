/**
 * Modul Pencarian Web via DuckDuckGo (Tanpa API Key)
 * Digunakan oleh AI saat mencari referensi script/dokumentasi terbaru.
 */

export interface SearchResultItem {
  title: string;
  snippet: string;
  url: string;
}

/**
 * Mencari query di DuckDuckGo menggunakan Lite/HTML endpoint
 */
export async function searchDuckDuckGo(query: string, maxResults = 4): Promise<SearchResultItem[]> {
  try {
    const encodedQuery = encodeURIComponent(query);
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

    const res = await fetch(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!res.ok) {
      // Fallback ke Instant Answer API jika HTML diblokir
      return await searchDuckDuckGoApi(query);
    }

    const html = await res.text();
    const results: SearchResultItem[] = [];

    // Parsing hasil snippet dari HTML DuckDuckGo
    const resultBlocks = html.split(/class="result__body"/g).slice(1);

    for (const block of resultBlocks.slice(0, maxResults)) {
      // Ekstrak Judul
      const titleMatch = block.match(/class="result__snippet[^>]*>([\s\S]*?)<\/a>/i) ||
                         block.match(/class="result__title[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
      // Ekstrak Snippet / Deskripsi
      const snippetMatch = block.match(/class="result__snippet[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i);
      // Ekstrak Link
      const urlMatch = block.match(/class="result__url[^>]*href="([^"]+)"/i) ||
                       block.match(/class="result__url"[^>]*>([\s\S]*?)<\/a>/i);

      const title = titleMatch ? cleanHtml(titleMatch[1]) : "Hasil Web";
      const snippet = snippetMatch ? cleanHtml(snippetMatch[1]) : "";
      let url = urlMatch ? cleanHtml(urlMatch[1]) : "";

      if (url.startsWith("//")) url = `https:${url}`;

      if (snippet) {
        results.push({ title, snippet, url });
      }
    }

    if (results.length === 0) {
      return await searchDuckDuckGoApi(query);
    }

    return results;
  } catch (err) {
    console.warn("[DDG Search Error]", err);
    return [];
  }
}

/**
 * Fallback menggunakan DuckDuckGo Instant Answer API (JSON)
 */
async function searchDuckDuckGoApi(query: string): Promise<SearchResultItem[]> {
  try {
    const apiUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(apiUrl);
    if (!res.ok) return [];

    const data: any = await res.json();
    const results: SearchResultItem[] = [];

    if (data.AbstractText) {
      results.push({
        title: data.Heading || query,
        snippet: data.AbstractText,
        url: data.AbstractURL || "https://duckduckgo.com",
      });
    }

    if (Array.isArray(data.RelatedTopics)) {
      for (const topic of data.RelatedTopics.slice(0, 3)) {
        if (topic.Text && topic.FirstURL) {
          results.push({
            title: topic.Text.slice(0, 50) + "...",
            snippet: topic.Text,
            url: topic.FirstURL,
          });
        }
      }
    }

    return results;
  } catch {
    return [];
  }
}

function cleanHtml(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}