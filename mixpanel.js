const axios = require("axios");

// Query API / Export API 엔드포인트
const QUERY_URL = "https://mixpanel.com/api/2.0";
const EXPORT_URL = "https://data.mixpanel.com/api/2.0/export";
const LEXICON_URL = "https://mixpanel.com/api/app/projects";

// ─────────────────────────────────────────
// 인증: Service Account (Basic Auth)
// username = MIXPANEL_SA_USERNAME  (예: abc.serviceaccount@mixpanel.com)
// password = MIXPANEL_SA_SECRET
// API Secret은 deprecated → Service Account 사용
// ─────────────────────────────────────────
function getAuthHeader() {
  const username = process.env.MIXPANEL_SA_USERNAME;
  const password = process.env.MIXPANEL_SA_SECRET;
  const encoded = Buffer.from(`${username}:${password}`).toString("base64");
  return `Basic ${encoded}`;
}

function pid() {
  return process.env.MIXPANEL_PROJECT_ID;
}

// ─────────────────────────────────────────
// 1. 이벤트 집계 (segmentation)
//    전환율·이벤트 횟수·추이 등 일반 통계
// ─────────────────────────────────────────
async function getAggregatedStats({
  event,
  from_date,
  to_date,
  type = "general",
  unit = "day",
  on,
}) {
  const params = { project_id: pid(), event, from_date, to_date, type, unit };
  if (on) params.on = on;
  const res = await axios.get(`${QUERY_URL}/segmentation`, {
    headers: { Authorization: getAuthHeader() },
    params,
  });
  return res.data;
}

// ─────────────────────────────────────────
// 2. 원시 이벤트 로그 export
//    세션 분석·체류시간·날짜 비교·필터링 등
//    로우 데이터가 필요한 모든 케이스
// ─────────────────────────────────────────
async function exportRawEvents({
  from_date,
  to_date,
  event,
  where,
  limit = 5000,
}) {
  const params = { project_id: pid(), from_date, to_date };
  if (event) params.event = JSON.stringify([event]);
  if (where) params.where = where;

  const res = await axios.get(EXPORT_URL, {
    headers: { Authorization: getAuthHeader() },
    params,
    responseType: "text",
  });

  // export API → 줄바꿈 구분 NDJSON
  const lines = (res.data || "").trim().split("\n").filter(Boolean);
  const events = lines.slice(0, limit).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

  // Claude에게 넘길 때 토큰 절약을 위해 필드 정리
  const slim = events.map((e) => ({
    distinct_id: e.distinct_id,
    event: e.event,
    time: e.properties?.$time || e.properties?.time,
    path: e.properties?.page_path || e.properties?.["$current_url"],
    ...Object.fromEntries(
      Object.entries(e.properties || {})
        .filter(([k]) => !k.startsWith("$"))
        .slice(0, 10),
    ),
  }));

  return { total: lines.length, returned: events.length, events: slim };
}

// ─────────────────────────────────────────
// 3. 퍼널 분석
// ─────────────────────────────────────────
async function getFunnel({ funnel_id, from_date, to_date, unit = "day" }) {
  const res = await axios.get(`${QUERY_URL}/funnels`, {
    headers: { Authorization: getAuthHeader() },
    params: { project_id: pid(), funnel_id, from_date, to_date, unit },
  });
  return res.data;
}

// ─────────────────────────────────────────
// 4. 리텐션 분석
// ─────────────────────────────────────────
async function getRetention({
  born_event,
  return_event,
  from_date,
  to_date,
  unit = "day",
  interval_count = 7,
}) {
  const res = await axios.get(`${QUERY_URL}/retention`, {
    headers: { Authorization: getAuthHeader() },
    params: {
      project_id: pid(),
      from_date,
      to_date,
      born_event,
      event: return_event,
      interval: 1,
      interval_count,
      unit,
      retention_type: "birth",
    },
  });
  return res.data;
}

// ─────────────────────────────────────────
// 5. TOP 이벤트 목록
// ─────────────────────────────────────────
async function getTopEvents({
  from_date,
  to_date,
  limit = 20,
  type = "general",
}) {
  const res = await axios.get(`${QUERY_URL}/events/top`, {
    headers: { Authorization: getAuthHeader() },
    params: { project_id: pid(), from_date, to_date, limit, type },
  });
  return res.data;
}

// ─────────────────────────────────────────
// 6. 속성별 세그멘테이션
// ─────────────────────────────────────────
async function getSegmentByProperty({
  event,
  property,
  from_date,
  to_date,
  unit = "day",
  type = "general",
}) {
  return getAggregatedStats({
    event,
    from_date,
    to_date,
    type,
    unit,
    on: `properties["${property}"]`,
  });
}

// ─────────────────────────────────────────
// 7. 이벤트·속성 스키마 조회 (Lexicon API)
//    Claude가 분석 전 실제 이벤트명/속성명 확인용
// ─────────────────────────────────────────
async function getEventSchemas({ entity_type = "event" }) {
  const res = await axios.get(
    `${LEXICON_URL}/${pid()}/schemas/${entity_type}`,
    { headers: { Authorization: getAuthHeader() } },
  );

  // 스키마에서 이벤트명 + 주요 속성만 추려서 반환 (토큰 절약)
  const schemas = res.data?.results || res.data || [];
  return schemas.map((s) => ({
    name: s.entityType === "event" ? s.name : s.name,
    description: s.schemaJson?.description || "",
    properties: Object.entries(s.schemaJson?.properties || {})
      .slice(0, 15)
      .map(([k, v]) => ({
        name: k,
        type: v.type,
        description: v.description || "",
      })),
  }));
}

// ─────────────────────────────────────────
// 8. JQL (JavaScript Query Language)
//    집계·필터·계산을 쿼리 안에서 처리
//    → 로우 데이터를 Claude에게 넘기지 않고
//      집계된 결과만 반환 → 토큰 문제 없음
//    → 어떤 복잡한 분석이든 자유롭게 표현 가능
// ─────────────────────────────────────────
async function executeJql({ script }) {
  const res = await axios.post(
    `${QUERY_URL}/jql`,
    `script=${encodeURIComponent(script)}`,
    {
      headers: {
        Authorization: getAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      params: { project_id: pid() },
    },
  );
  return res.data;
}

// ─────────────────────────────────────────
// 도구 실행 라우터
// ─────────────────────────────────────────
async function executeTool(toolName, toolInput) {
  const map = {
    get_aggregated_stats: getAggregatedStats,
    export_raw_events: exportRawEvents,
    get_funnel: getFunnel,
    get_retention: getRetention,
    get_top_events: getTopEvents,
    get_segment_by_property: getSegmentByProperty,
    get_event_schemas: getEventSchemas,
    execute_jql: executeJql,
  };

  const fn = map[toolName];
  if (!fn) throw new Error(`알 수 없는 도구: ${toolName}`);
  return await fn(toolInput);
}

module.exports = { executeTool };
