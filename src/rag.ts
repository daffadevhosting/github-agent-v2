import type { Env, VectorizeIndex } from "./types";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const MAX_CHUNK_LENGTH = 1800;

export interface CodeChunk {
  id: string;
  path: string;
  content: string;
  startLine: number;
  endLine: number;
}

function chunkFile(path: string, content: string): CodeChunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: CodeChunk[] = [];
  for (let start = 0; start < lines.length; start += 80) {
    const selected = lines.slice(start, start + 80);
    const text = selected.join("\n").trim();
    if (!text) continue;
    chunks.push({
      id: `${path}:${start + 1}`,
      path,
      content: text.slice(0, MAX_CHUNK_LENGTH),
      startLine: start + 1,
      endLine: Math.min(lines.length, start + selected.length),
    });
  }
  return chunks;
}

async function embed(env: Env, texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const result = await env.AI.run(EMBEDDING_MODEL, { text: texts });
  const data = (result as { data?: unknown }).data;
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error("Model embedding tidak mengembalikan vector yang valid.");
  }
  return data as number[][];
}

function getIndex(env: Env): VectorizeIndex {
  if (!env.VECTOR_INDEX) {
    throw new Error("Vectorize belum dikonfigurasi. Tambahkan binding VECTOR_INDEX terlebih dahulu.");
  }
  return env.VECTOR_INDEX;
}

export async function indexRepositoryFiles(
  env: Env,
  owner: string,
  repo: string,
  branch: string,
  files: Array<{ path: string; content: string }>
): Promise<{ indexed: number }> {
  const chunks = files.flatMap((file) => chunkFile(file.path, file.content));
  const vectors = await embed(env, chunks.map((chunk) => `${chunk.path}\n${chunk.content}`));
  const namespace = `${owner}/${repo}@${branch}`;
  await getIndex(env).upsert(
    chunks.map((chunk, index) => ({
      id: `${namespace}:${chunk.id}`,
      values: vectors[index],
      namespace,
      metadata: {
        owner,
        repo,
        branch,
        path: chunk.path,
        content: chunk.content,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      },
    }))
  );
  return { indexed: chunks.length };
}

export async function searchRepository(
  env: Env,
  owner: string,
  repo: string,
  branch: string,
  query: string,
  topK = 6
): Promise<CodeChunk[]> {
  const [queryVector] = await embed(env, [query]);
  const result = await getIndex(env).query(queryVector, {
    namespace: `${owner}/${repo}@${branch}`,
    topK: Math.min(Math.max(topK, 1), 20),
    returnMetadata: "all",
  });
  return (result.matches || []).flatMap((match) => {
    const metadata = match.metadata;
    if (!metadata || typeof metadata.path !== "string" || typeof metadata.content !== "string") {
      return [];
    }
    return [{
      id: match.id,
      path: metadata.path,
      content: metadata.content,
      startLine: Number(metadata.startLine || 1),
      endLine: Number(metadata.endLine || 1),
    }];
  });
}

export async function buildRepositoryContext(
  env: Env,
  owner: string,
  repo: string,
  branch: string,
  query: string
): Promise<string> {
  if (!env.VECTOR_INDEX) return "";
  const chunks = await searchRepository(env, owner, repo, branch, query);
  if (!chunks.length) return "";
  return chunks
    .map((chunk) => `### ${chunk.path}:${chunk.startLine}-${chunk.endLine}\n${chunk.content}`)
    .join("\n\n");
}
