const Anthropic = require("@anthropic-ai/sdk");
const { executeTool } = require("./mixpanel");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─────────────────────────────────────────
// Claude에게 제공할 Mixpanel 도구 목록
// 이 목록만 늘리면 대응 가능한 질문 유형이 자동으로 확장됨
// ─────────────────────────────────────────
const MIXPANEL_TOOLS = [
  {
    name: "get_aggregated_stats",
    description: `이벤트 집계 데이터를 조회합니다.
용도: 전환율, 이벤트 발생 횟수, 일별/주별 추이, 유니크 유저 수 등 일반적인 통계.
날짜 범위와 이벤트명을 지정하면 unit(day/week/month) 단위로 집계된 수치를 반환합니다.
type=unique 로 설정하면 유니크 유저 기준으로 집계합니다.`,
    input_schema: {
      type: "object",
      properties: {
        event: {
          type: "string",
          description: '이벤트명 (예: "Purchase Complete", "Product View")',
        },
        from_date: { type: "string", description: "시작일 YYYY-MM-DD" },
        to_date: { type: "string", description: "종료일 YYYY-MM-DD" },
        type: {
          type: "string",
          enum: ["general", "unique"],
          description: "general=전체 발생수, unique=유니크 유저 수",
        },
        unit: {
          type: "string",
          enum: ["day", "week", "month"],
          description: "집계 단위",
        },
        on: {
          type: "string",
          description: '속성별 분류 시 사용 (예: properties["page_type"])',
        },
      },
      required: ["event", "from_date", "to_date"],
    },
  },
  {
    name: "export_raw_events",
    description: `원시 이벤트 로그를 가져옵니다.
용도: 세션 분석, 체류시간·이탈률 계산, 특정 날짜 비교, 특정 페이지/상품 필터링,
     퍼널 직접 계산, 사용자 행동 패턴 분석 등 집계 API로 불가능한 모든 케이스.
where 파라미터로 특정 상품·페이지 조건을 SQL처럼 필터링할 수 있습니다.
반환 데이터: distinct_id, event명, 타임스탬프, 페이지 경로 등 이벤트 속성 포함.`,
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "시작일 YYYY-MM-DD" },
        to_date: { type: "string", description: "종료일 YYYY-MM-DD" },
        event: {
          type: "string",
          description: "특정 이벤트만 필터 (없으면 전체)",
        },
        where: {
          type: "string",
          description:
            'JQL 필터 (예: properties["page_path"] == "/product/123")',
        },
        limit: { type: "number", description: "최대 반환 건수 (기본 5000)" },
      },
      required: ["from_date", "to_date"],
    },
  },
  {
    name: "get_funnel",
    description: `퍼널 분석 데이터를 조회합니다.
용도: 상품조회 → 장바구니 → 결제 시작 → 구매완료 단계별 전환율, 어느 단계에서 이탈이 많은지.
Mixpanel에 미리 정의된 funnel_id가 필요합니다.`,
    input_schema: {
      type: "object",
      properties: {
        funnel_id: { type: "string", description: "Mixpanel Funnel ID" },
        from_date: { type: "string", description: "시작일 YYYY-MM-DD" },
        to_date: { type: "string", description: "종료일 YYYY-MM-DD" },
        unit: { type: "string", enum: ["day", "week", "month"] },
      },
      required: ["funnel_id", "from_date", "to_date"],
    },
  },
  {
    name: "get_retention",
    description: `리텐션(재방문) 분석 데이터를 조회합니다.
용도: 신규 유저가 일정 기간 후 얼마나 재방문하는지, 코호트별 재방문율.
born_event(최초 진입 이벤트)와 return_event(재방문 이벤트)를 지정합니다.`,
    input_schema: {
      type: "object",
      properties: {
        born_event: {
          type: "string",
          description: '최초 진입 이벤트 (예: "Page View")',
        },
        return_event: {
          type: "string",
          description: '재방문 이벤트 (예: "Purchase Complete")',
        },
        from_date: { type: "string", description: "시작일 YYYY-MM-DD" },
        to_date: { type: "string", description: "종료일 YYYY-MM-DD" },
        unit: { type: "string", enum: ["day", "week", "month"] },
        interval_count: {
          type: "number",
          description: "분석할 기간 수 (기본 7)",
        },
      },
      required: ["born_event", "return_event", "from_date", "to_date"],
    },
  },
  {
    name: "get_top_events",
    description: `가장 많이 발생한 이벤트 목록을 조회합니다.
용도: 어떤 이벤트가 가장 많이 발생했는지 전체 현황 파악, 이상 이벤트 감지.`,
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "시작일 YYYY-MM-DD" },
        to_date: { type: "string", description: "종료일 YYYY-MM-DD" },
        limit: { type: "number", description: "반환할 이벤트 수 (기본 20)" },
        type: { type: "string", enum: ["general", "unique"] },
      },
      required: ["from_date", "to_date"],
    },
  },
  {
    name: "get_segment_by_property",
    description: `특정 속성값별로 이벤트를 분류해 조회합니다.
용도: 기기별(모바일/PC), 유입경로별, 페이지별, 상품 카테고리별 이벤트 분포 비교.`,
    input_schema: {
      type: "object",
      properties: {
        event: { type: "string", description: "이벤트명" },
        property: {
          type: "string",
          description: '분류 기준 속성명 (예: "page_type", "referrer")',
        },
        from_date: { type: "string", description: "시작일 YYYY-MM-DD" },
        to_date: { type: "string", description: "종료일 YYYY-MM-DD" },
        type: { type: "string", enum: ["general", "unique"] },
      },
      required: ["event", "property", "from_date", "to_date"],
    },
  },
  {
    name: "get_event_schemas",
    description: `Mixpanel Lexicon에 등록된 이벤트 목록과 각 이벤트의 속성(property) 스키마를 조회합니다.
분석 전 반드시 이 도구를 먼저 호출해 실제 이벤트명과 속성명을 확인하세요.
이벤트명 오타나 잘못된 속성명으로 발생하는 빈 결과를 방지할 수 있습니다.`,
    input_schema: {
      type: "object",
      properties: {
        entity_type: {
          type: "string",
          enum: ["event", "profile"],
          description:
            "event=이벤트 스키마, profile=유저 속성 스키마 (기본값: event)",
        },
      },
      required: [],
    },
  },
  {
    name: "execute_jql",
    description: `Mixpanel JQL(JavaScript Query Language)을 직접 작성해 실행합니다.
이 도구는 로우 데이터를 Claude에게 넘기지 않고 Mixpanel 서버에서 집계·계산을 완료한 결과만 반환합니다.
어떤 복잡한 분석이든 JQL 스크립트로 자유롭게 표현할 수 있습니다.

적합한 케이스:
- 스크롤 뎁스, 체류시간, 세션 이탈률 등 계산이 필요한 지표
- 특정 상품·페이지만 필터링한 분석
- 날짜별/기간별 비교
- 사용자 행동 패턴, 코호트 분석
- get_aggregated_stats로 표현 안 되는 모든 복잡한 쿼리

JQL 문법:
  function main() {
    return Events({
      from_date: "YYYY-MM-DD",
      to_date:   "YYYY-MM-DD",
      event_selectors: [{ event: "실제이벤트명" }]
    })
    .filter(function(e) {
      return e.properties["속성명"] === "값";
    })
    .groupBy(["properties.속성명"], mixpanel.reducer.count());
  }

주요 reducer:
  mixpanel.reducer.count()           — 이벤트 수
  mixpanel.reducer.sum("속성명")      — 합계
  mixpanel.reducer.avg("속성명")      — 평균
  mixpanel.reducer.numeric_summary("속성명") — min/max/avg/sum

사용자별 집계:
  .groupByUser(["properties.속성명"], function(state, events) { ... })

여러 날짜 비교: Events() 블록을 from_date/to_date를 다르게 해서 두 번 호출 후 결과 합산`,
    input_schema: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description:
            "실행할 JQL 스크립트. function main() { ... } 형태로 작성",
        },
      },
      required: ["script"],
    },
  },
];

// ─────────────────────────────────────────
// 시스템 프롬프트
// ─────────────────────────────────────────
function buildSystemPrompt() {
  const today = new Date().toISOString().split("T")[0];
  return `당신은 카페24 자사몰의 Mixpanel 데이터 분석 전문가입니다.
오늘 날짜: ${today}

[필수 분석 절차]
1. 모든 질문에서 가장 먼저 get_event_schemas 도구를 호출해 실제 이벤트명과 속성명을 확인하세요.
2. 단순 집계(이벤트 수, 전환율 추이)는 get_aggregated_stats 사용.
3. 필터링·계산·날짜 비교·스크롤·체류시간 등 복잡한 분석은 반드시 execute_jql 사용.
   → export_raw_events는 토큰 한도를 초과하므로 사용 금지.

[execute_jql 사용 기준]
다음 중 하나라도 해당하면 execute_jql을 사용하세요:
- 특정 상품명/페이지로 필터링이 필요한 경우
- 스크롤 뎁스, 체류시간, 이탈률 등 계산이 필요한 경우
- 두 날짜/기간을 비교하는 경우
- 사용자별 행동 패턴 분석이 필요한 경우
- get_aggregated_stats로 표현할 수 없는 경우

[JQL 작성 가이드]
스크롤 뎁스 예시:
  function main() {
    return Events({
      from_date: "2026-03-24", to_date: "2026-03-24",
      event_selectors: [{ event: "스키마에서_확인한_이벤트명" }]
    })
    .filter(e => e.properties["product_name"] === "풀리오 프리미엄 마사지 매트")
    .groupBy([], function(accum, items) {
      var total = items.length;
      var reached = items.filter(e => (e.properties["scroll_depth"] || 0) >= 25).length;
      return [{ total: total, reached: reached, rate: total > 0 ? (reached/total*100).toFixed(1)+"%" : "0%" }];
    });
  }

날짜 비교 예시 (두 번 호출 후 비교):
  첫 번째 execute_jql → from_date/to_date를 3/24로
  두 번째 execute_jql → from_date/to_date를 3/25로
  → 결과를 받은 후 Claude가 직접 비교 분석

[답변 형식 — 슬랙 mrkdwn]
*📊 분석 결과*
핵심 수치 bullet 정리

*💡 인사이트*
데이터의 의미 2~3줄

*🎯 추천 액션*
구체적인 개선 방안 1~2개

[주의]
- 항상 한국어로 답변
- 수치는 단위 명확히 (회, 명, %, 원)
- export_raw_events는 절대 사용하지 마세요 (토큰 한도 초과)
- 슬랙 mrkdwn 형식 사용 (*굵게*, _기울임_)`;
}

// ─────────────────────────────────────────
// 핵심: Agentic Tool Use 루프
// Claude가 스스로 도구를 선택·실행하고
// 결과를 보고 추가 도구 호출 여부를 결정
// ─────────────────────────────────────────
async function analyzeWithToolUse(question) {
  const messages = [{ role: "user", content: question }];
  const MAX_ITERATIONS = 6; // 무한루프 방지

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: buildSystemPrompt(),
      tools: MIXPANEL_TOOLS,
      messages,
    });

    // ── 종료 조건: 최종 텍스트 답변 완성 ──
    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      return textBlock?.text || "분석 결과를 생성하지 못했습니다.";
    }

    // ── 도구 호출 요청이 있으면 실행 ──
    if (response.stop_reason === "tool_use") {
      // assistant 메시지 히스토리에 추가
      messages.push({ role: "assistant", content: response.content });

      // 병렬 도구 실행 (Claude가 여러 도구를 동시에 요청할 수 있음)
      const toolResults = await Promise.all(
        response.content
          .filter((b) => b.type === "tool_use")
          .map(async (toolCall) => {
            console.log(
              `[도구 호출] ${toolCall.name}`,
              JSON.stringify(toolCall.input),
            );
            let result;
            try {
              result = await executeTool(toolCall.name, toolCall.input);
            } catch (err) {
              result = { error: err.message };
            }
            console.log(
              `[도구 결과] ${toolCall.name} → ${JSON.stringify(result).slice(0, 200)}...`,
            );
            return {
              type: "tool_result",
              tool_use_id: toolCall.id,
              content: JSON.stringify(result),
            };
          }),
      );

      // 도구 결과를 user 메시지로 추가 → 다음 루프에서 Claude가 결과를 보고 판단
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // 예상치 못한 stop_reason
    break;
  }

  return "분석 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.";
}

module.exports = { analyzeWithToolUse };
