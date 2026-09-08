export const ISSUE_REPORT_TOKEN_BUCKET_SCRIPT = `
local nowParts = redis.call('TIME')
local now = (tonumber(nowParts[1]) * 1000) + math.floor(tonumber(nowParts[2]) / 1000)
local capacity = tonumber(ARGV[1])
local refillMs = tonumber(ARGV[2])
local ttlMs = tonumber(ARGV[3])
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens')) or capacity
local updatedAt = tonumber(redis.call('HGET', KEYS[1], 'updatedAt')) or now
if now > updatedAt then
  tokens = math.min(capacity, tokens + ((now - updatedAt) / refillMs))
end
local allowed = 0
local retryAfter = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retryAfter = math.max(1, math.ceil(((1 - tokens) * refillMs) / 1000))
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'updatedAt', tostring(now))
redis.call('PEXPIRE', KEYS[1], ttlMs)
return {allowed, retryAfter}
`;

export async function consumeRedisTokenBucket(
  redis: {
    eval: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>;
  },
  key: string,
  config: { capacity: number; refillMs: number; ttlMs: number },
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const result = await redis.eval(ISSUE_REPORT_TOKEN_BUCKET_SCRIPT, {
    keys: [key],
    arguments: [String(config.capacity), String(config.refillMs), String(config.ttlMs)],
  });
  if (!Array.isArray(result) || result.length < 2) {
    throw new Error("ISSUE_REPORT_RATE_RESPONSE_INVALID");
  }
  return {
    allowed: Number(result[0]) === 1,
    retryAfterSeconds: Math.max(0, Number(result[1]) || 0),
  };
}
