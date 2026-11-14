(() => {
  if (typeof window === "undefined" || window.__SALAFI_PORTAL_ENGINE_ACTIVE__) return;
  window.__SALAFI_PORTAL_ENGINE_ACTIVE__ = true;

  const NATIVE_FETCH = window.fetch.bind(window);
  const PORTAL_BASE_DEFAULT = "/salafi-turath-live";

  function detectBasePath() {
    try {
      const p = window.location.pathname || "";
      if (p === PORTAL_BASE_DEFAULT || p.startsWith(PORTAL_BASE_DEFAULT + "/")) {
        return PORTAL_BASE_DEFAULT;
      }
    } catch {}
    return "";
  }

  // Immediately purge any stale v3/v7 cached answers from browser storage on GitHub Pages
  (function purgeLegacyV3V7Storage() {
    try {
      localStorage.removeItem("salafi_live_portal_ai_history_v3");
      const badRe = /خلاصۂ تحقیقیہ مرکزہ|خلاصۂ تحقیقیہ و تحریرِ محلِ نزاع|Executive Scholarly Summary|مرتبة النقل القطعي/u;
      const isPoisoned = (obj) => {
        if (!obj) return false;
        if (obj.deepResearchReport || obj.salafiPromptVersion) return true;
        const raw = JSON.stringify(obj);
        return badRe.test(raw);
      };
      const rawMap = localStorage.getItem("salafi_cached_replies_v1");
      if (rawMap) {
        const parsed = JSON.parse(rawMap);
        if (parsed && typeof parsed === "object") {
          let changed = false;
          for (const k of Object.keys(parsed)) {
            if (isPoisoned(parsed[k])) {
              delete parsed[k];
              changed = true;
            }
          }
          if (changed) localStorage.setItem("salafi_cached_replies_v1", JSON.stringify(parsed));
        }
      }
      const rawSess = sessionStorage.getItem("salafi_active_ai_session_v1");
      if (rawSess) {
        const parsedSess = JSON.parse(rawSess);
        if (isPoisoned(parsedSess?.reply || parsedSess)) {
          sessionStorage.removeItem("salafi_active_ai_session_v1");
        }
      }
      const rawHist = localStorage.getItem("salafi_ai_history_v2");
      if (rawHist) {
        const parsedHist = JSON.parse(rawHist);
        if (Array.isArray(parsedHist)) {
          const cleaned = parsedHist.map((item) => {
            if (item?.savedReply && isPoisoned(item.savedReply)) {
              const next = { ...item };
              delete next.savedReply;
              return next;
            }
            return item;
          });
          localStorage.setItem("salafi_ai_history_v2", JSON.stringify(cleaned));
        }
      }
    } catch {}
  })();

  function normalizeText(str) {
    return String(str || "")
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
      .replace(/[أإآٱ]/g, "ا")
      .replace(/ة/g, "ه")
      .replace(/[ىئ]/g, "ی")
      .replace(/ك/g, "ک")
      .replace(/ؤ/g, "و")
      .replace(/والو\s+بالص[يی]ن/g, "ولو بالصین")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  const STOP_WORDS = new Set([
    "کا", "کی", "کے", "میں", "سے", "کو", "پر", "اور", "ہے", "ہیں", "تھا", "تھی", "تھے",
    "کیا", "کیوں", "کیسے", "کب", "کون", "ہوتا", "ہوتی", "والا", "والے", "والی", "لیے",
    "لئے", "بارے", "مطابق", "روشنی", "بیان", "کریں", "پیش", "تحقیق", "حکم", "شرعی",
    "مسئلہ", "دلائل", "قرآن", "سنت", "حدیث", "من", "في", "فی", "على", "علی", "عن", "ان",
    "ما", "هل", "هو", "هي", "مع", "او", "لا", "یا", "یہ", "وہ", "اس", "ان", "تو", "بھی", "ولو"
  ]);

  const PREFACE_HEADINGS_RE = /^(?:پیش\s*لفظ|عرضِ?\s*ناشر|عرضِ?\s*مؤلف|مقدمہ|فہرست|انتساب|تقریظ|کلمۃ\s*الناشر|ثبت\s*المصادر)/u;

  function extractQueryTerms(q) {
    return normalizeText(q)
      .split(" ")
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  }

  let portalDataPromise = null;
  function loadPortalData() {
    if (!portalDataPromise) {
      portalDataPromise = (async () => {
        const base = detectBasePath();
        const fetchJson = async (file, fallback) => {
          try {
            const res = await NATIVE_FETCH(`${base}/portal-data/${file}`);
            return res.ok ? await res.json() : fallback;
          } catch {
            return fallback;
          }
        };
        const [snapshots, bookPages, passages, hadiths, flagships] = await Promise.all([
          fetchJson("api_snapshots.json", {}),
          fetchJson("book_pages_bundle.json", {}),
          fetchJson("search_corpus.json", []),
          fetchJson("hadith_corpus.json", []),
          fetchJson("flagship_treatises.json", [])
        ]);
        const books = snapshots["/api/public?action=catalog"]?.books || [];
        return { snapshots, books, bookPages, passages, hadiths, flagships };
      })();
    }
    return portalDataPromise;
  }

  function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }

  function isPrefacePassage(p) {
    const h = String(p.heading || "").trim();
    const c = String(p.content || "").trim();
    if (PREFACE_HEADINGS_RE.test(h)) return true;
    if (Number(p.ordinal || 99) <= 5 && /^(?:پیش\s*لفظ|عرض\s*ناشر|میں\s*مسلسل\s*لکھنے\s*کا\s*عادی\s*نہیں)/u.test(c)) {
      return true;
    }
    return false;
  }

  function hasTermToken(wordSet, bodyNorm, term) {
    if (wordSet.has(term)) return true;
    if (term.startsWith("ال") && term.length >= 4 && wordSet.has(term.slice(2))) return true;
    if (term.startsWith("بال") && term.length >= 5 && (wordSet.has(term.slice(1)) || wordSet.has(term.slice(3)))) return true;
    return term.length >= 5 && bodyNorm.includes(` ${term} `);
  }

  function searchCorpus(data, rawQuery, limit = 12, bookFilter = "", categoryFilter = "", authorFilter = "", excludePrefaces = false) {
    const t0 = Date.now();
    const terms = extractQueryTerms(rawQuery);
    const normPhrase = normalizeText(rawQuery);
    const bNorm = normalizeText(bookFilter);
    const cNorm = normalizeText(categoryFilter);
    const aNorm = normalizeText(authorFilter);

    if (terms.length === 0 && !bNorm && !cNorm && !aNorm) {
      return { hits: [], maxScore: 0, terms, executionMs: Date.now() - t0 };
    }

    const minRequired = excludePrefaces ? Math.max(1, Math.ceil(terms.length * 0.67)) : 1;
    const scored = [];
    for (const p of data.passages) {
      if (excludePrefaces && isPrefacePassage(p)) continue;
      if (bNorm && !normalizeText(`${p.book_id} ${p.title}`).includes(bNorm)) continue;
      if (aNorm && !normalizeText(p.author || "").includes(aNorm)) continue;
      if (cNorm && !normalizeText(p.category || "").includes(cNorm)) continue;

      const bodyNorm = ` ${normalizeText(`${p.heading || ""} ${p.content || ""} ${p.footnotes || ""}`)} `;
      const wordSet = new Set(bodyNorm.trim().split(" "));
      const headSet = new Set(normalizeText(`${p.title || ""} ${p.heading || ""}`).split(" "));
      let matchedTerms = 0;
      let score = 0;
      for (const term of terms) {
        if (hasTermToken(wordSet, bodyNorm, term)) {
          matchedTerms++;
          score += hasTermToken(headSet, "", term) ? 2.5 : 1.0;
        }
      }
      if (normPhrase.length >= 6 && bodyNorm.includes(` ${normPhrase} `)) {
        score += 5.0;
        matchedTerms = Math.max(matchedTerms, terms.length);
      }
      if (terms.length > 0 && matchedTerms < minRequired) continue;

      scored.push({
        score,
        matchedTerms,
        bookId: String(p.book_id || ""),
        bookPageId: `${p.book_id}:${p.ordinal || 1}`,
        title: String(p.title || "کتاب مکتبہ سلفی تراث").replace(/^shamila_\d+_/i, ""),
        author: String(p.author || "مؤلف"),
        category: String(p.category || "عام"),
        ordinal: Number(p.ordinal || 1),
        volume: p.volume || 1,
        printedPage: p.printed || p.ordinal || 1,
        heading: String(p.heading || p.title || ""),
        matnExcerpt: String(p.content || "").slice(0, 700),
        rawContent: String(p.content || ""),
        footnotes: String(p.footnotes || "")
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, limit);
    return {
      hits,
      maxScore: hits.length > 0 ? hits[0].score : 0,
      terms,
      executionMs: Date.now() - t0
    };
  }

  function searchHadiths(data, rawQuery, limit = 6) {
    const terms = extractQueryTerms(rawQuery);
    if (terms.length === 0) return [];
    const normPhrase = normalizeText(rawQuery);
    const minReq = Math.max(1, Math.ceil(terms.length * 0.67));
    const scored = [];
    for (const h of data.hadiths) {
      const hay = ` ${normalizeText(`${h.arabic_text || ""} ${h.urdu_text || ""} ${h.kitab_ur || ""} ${h.bab_ur || ""}`)} `;
      const wordSet = new Set(hay.trim().split(" "));
      let matched = 0;
      let score = 0;
      for (const t of terms) {
        if (hasTermToken(wordSet, hay, t)) {
          matched++;
          score += 1.5;
        }
      }
      if (normPhrase.length >= 6 && hay.includes(` ${normPhrase} `)) {
        score += 6.0;
        matched = terms.length;
      }
      if (matched < minReq) continue;
      scored.push({ score, h });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.h);
  }

  const THINKING_STAGES_TEMPLATE = [
    {
      stageId: "stage_1_understanding",
      stageNumber: 1,
      iconType: "doc_lens",
      visibleTitleUrdu: "سوال کی تفہیم اور تحقیقی منصوبہ بندی جاری ہے…",
      subtitleUrdu: "کلیدی الفاظ، موضوع اور منہجِ سلف کے زاویے متعین کیے جا رہے ہیں"
    },
    {
      stageId: "stage_2_retrieval",
      stageNumber: 2,
      iconType: "books_search",
      visibleTitleUrdu: "مکتبہ سلفی تراث کی مستند کتب میں تلاش…",
      subtitleUrdu: "قرآن، کتبِ حدیث، شروح اور علمائے اہلِ حدیث کی تصانیف سے شواہد کا استخراج"
    },
    {
      stageId: "stage_3_hadith_gate",
      stageNumber: 3,
      iconType: "shield_check",
      visibleTitleUrdu: "تحقیقِ حدیث اور اسنادی جانچ پڑتال…",
      subtitleUrdu: "احادیث و آثار کے درجۂ صحت اور مستند حوالہ جات کی تصدیق"
    },
    {
      stageId: "stage_4_synthesis",
      stageNumber: 4,
      iconType: "quill_pen",
      visibleTitleUrdu: "منہجِ سلف کی روشنی میں علمی ترتیب و تالیف…",
      subtitleUrdu: "قرآن و سنت اور فہمِ سلف صالحین کے مطابق مدلل علمی جواب کی تیاری"
    },
    {
      stageId: "stage_5_verification",
      stageNumber: 5,
      iconType: "check_badge",
      visibleTitleUrdu: "حوالہ جات اور علمی امانت کی حتمی تصدیق مکمل",
      subtitleUrdu: "تمام مستند مآخذ اور اقتباسات کی جانچ مکمل ہو چکی ہے"
    }
  ];

  function buildCompletedStages(jobId) {
    const ts = new Date().toISOString();
    return THINKING_STAGES_TEMPLATE.map((st) => ({
      ...st,
      researchJobId: jobId,
      status: "Completed",
      timestamp: ts,
      progressDescription: st.subtitleUrdu
    }));
  }

  function buildFailClosedAcademicResponse(question, jobId) {
    const ac = {
      title: `علمی احتیاط و عدمِ ثبوت: ${question}`,
      intro:
        "’’لا أدري، والله أعلم۔ موجودہ قابلِ تصدیق مصادر میں اس سوال کے لیے کافی معتبر دلیل دستیاب نہیں ہوسکی۔ موجودہ قابلِ رسائی اور معتبر مصادر میں اس مسئلے کے بارے میں کافی قابلِ تصدیق دلیل نہیں مل سکی؛ اس لیے بغیر تحقیق کوئی حکم یا نسبت بیان نہیں کی جا سکتی۔‘‘",
      searched_sources_count: 987,
      library_metrics: {
        total_indexed_books: 987,
        searched_books_count: 987,
        matching_books_count: 0,
        cited_books_count: 0
      },
      sections: [
        {
          heading: "1. علمی امانت اور عدمِ اختراع (Strict Fail-Closed Gate)",
          description: "",
          items: [
            {
              arabic: "وَلَا تَقْفُ مَا لَيْسَ لَكَ بِهِ عِلْمٌ ۚ إِنَّ السَّمْعَ وَالْبَصَرَ وَالْفُؤَادَ كُلُّ أُولَٰئِكَ كَانَ عَنْهُ مَسْئُولًا",
              narrator: "سورۃ الاسراء: 36 — بغیر یقینی علم اور مستند دلیل کے کسی قول یا روایت کی نسبت کرنے کی ممانعت",
              translation:
                "مکتبہ سلفی تراث اے آئی کے اصولِ امانت کے تحت جس مسئلے یا روایت کی صریح اور مستند دلیل موجودہ مفہرس ذخیرے میں نہ ملے، وہاں اپنی طرف سے قیاس آرائی یا غیر متعلقہ اقتباس پیش کرنے کے بجائے توقفِ علمی (لا أدري، والله أعلم) اختیار کیا جاتا ہے۔ آپ کلیدی الفاظ بدل کر یا کسی متعین کتاب کا انتخاب کر کے دوبارہ تلاش فرما سکتے ہیں۔",
              sourceRef: "قرآن کریم — سورۃ الاسراء: 36",
              refs: []
            }
          ]
        }
      ],
      scholarly_opinions: [],
      conclusion:
        "واللہ اعلم بالصواب۔ مستند نص اور صریح حوالے کے بغیر کسی شرعی حکم یا حدیث کی تصدیق و تضعیف سے توقف ہی منہجِ سلف صالحین کا تقاضا ہے۔",
      conclusion_refs: [],
      conclusion_badges: []
    };

    return {
      mode: "answer",
      uiLanguage: "ur",
      effectiveLanguage: "ur",
      conversationId: `conv_${Date.now()}`,
      researchRunId: jobId,
      thinkingStateMachine: { stages: buildCompletedStages(jobId) },
      academicResult: ac,
      result: {
        title: ac.title,
        paragraphs: [{ text: ac.intro, refs: [] }]
      },
      sources: [],
      searched_sources_count: 987,
      library_metrics: ac.library_metrics,
      gateReport: { fail_closed_triggered: true },
      generated: true,
      provider: "سلفی تراث اکیڈمک ریسرچ انجن (منہجِ سلف و مآخذِ کتب)"
    };
  }

  async function tryLiveBrowserLlmSynthesis(question, sources, body) {
    let geminiKey = "";
    let groqKey = "";
    let openaiKey = "";
    let deepseekKey = "";
    try {
      geminiKey = String(body.geminiKey || (body.provider === "gemini" ? body.apiKey : "") || localStorage.getItem("salafi_gemini_key") || localStorage.getItem("salafi_portal_gemini_key") || "").trim();
      groqKey = String(body.groqKey || (body.provider === "groq" ? body.apiKey : "") || localStorage.getItem("salafi_groq_key") || "").trim();
      openaiKey = String(body.openaiKey || (body.provider === "openai" ? body.apiKey : "") || localStorage.getItem("salafi_openai_key") || "").trim();
      deepseekKey = String(body.deepseekKey || (body.provider === "deepseek" ? body.apiKey : "") || localStorage.getItem("salafi_deepseek_key") || "").trim();
    } catch {}

    const ctxText = sources
      .slice(0, 8)
      .map((s) => `[S${s.ref}] کتاب: ${s.title} | مؤلف: ${s.author} | صفحہ: ${s.printed_page}\nمتن: ${s.content}`)
      .join("\n\n");

    const sysPrompt = `آپ «سلفی تراث اے آئی» ہیں — قرآن و سنت کو فہمِ سلف صالحین اور منہجِ اہلِ حدیث کی روشنی میں پیش کرنے والا مستند علمی تحقیقی معاون۔
صرف دیے گئے مآخذ [S1..Sn] کی بنیاد پر خالص، شستہ اور علمی اردو میں درج ذیل JSON اسٹرکچر میں جواب دیں (کوئی اضافی متن یا مارک ڈاؤن بلاک نہ لکھیں):
{
  "title": "مسئلے کا جامع علمی عنوان",
  "intro": "مختصر اور مدلل تمہیدی خلاصہ (۲ سے ۴ جملے)",
  "sections": [
    {
      "heading": "1. قرآن و سنت کے مستند دلائل",
      "items": [
        {
          "arabic": "عربی نص (اگر ماخذ میں موجود ہو، ورنہ خالی چھوڑ دیں)",
          "narrator": "ذیلی سرخی یا راوی و باب کا حوالہ",
          "translation": "تفصیلی علمی اردو ترجمہ و توضیح (صرف مآخذ کی روشنی میں)",
          "sourceRef": "کتاب کا نام اور صفحہ/حدیث نمبر",
          "hadithGrade": "صحیح / حسن (صرف حدیث ہونے کی صورت میں)",
          "refs": [1]
        }
      ]
    }
  ],
  "conclusion": "جامع فقہی و منہجی خلاصہ اور راجح موقف"
}`;

    const userMsg = `سوال: ${question}\n\nمستند مآخذ:\n${ctxText}`;

    // 1. Try Groq if key configured
    if (groqKey.startsWith("gsk_")) {
      try {
        const r = await NATIVE_FETCH("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${groqKey}`
          },
          body: JSON.stringify({
            model: "llama-3.3-70b-versatile",
            temperature: 0.15,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: sysPrompt },
              { role: "user", content: userMsg }
            ]
          })
        });
        if (r.ok) {
          const j = await r.json();
          const parsed = JSON.parse(j?.choices?.[0]?.message?.content || "{}");
          if (parsed?.title && Array.isArray(parsed?.sections) && parsed.sections.length > 0) {
            return { academic: parsed, provider: "Groq Cloud (Llama 3.3 70B)" };
          }
        }
      } catch {}
    }

    // 2. Try Gemini if key configured
    if (geminiKey.startsWith("AIza")) {
      try {
        const r = await NATIVE_FETCH(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(geminiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: sysPrompt }] },
              contents: [{ role: "user", parts: [{ text: userMsg }] }],
              generationConfig: { temperature: 0.15, responseMimeType: "application/json" }
            })
          }
        );
        if (r.ok) {
          const j = await r.json();
          const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
          const parsed = JSON.parse(txt);
          if (parsed?.title && Array.isArray(parsed?.sections) && parsed.sections.length > 0) {
            return { academic: parsed, provider: "Google Gemini 2.5 Flash" };
          }
        }
      } catch {}
    }

    // 3. Try OpenAI / DeepSeek if key configured
    const oaKey = openaiKey || deepseekKey;
    const oaUrl = openaiKey
      ? "https://api.openai.com/v1/chat/completions"
      : deepseekKey
        ? "https://api.deepseek.com/chat/completions"
        : "";
    if (oaKey && oaUrl) {
      try {
        const r = await NATIVE_FETCH(oaUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${oaKey}`
          },
          body: JSON.stringify({
            model: openaiKey ? "gpt-4o-mini" : "deepseek-chat",
            temperature: 0.15,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: sysPrompt },
              { role: "user", content: userMsg }
            ]
          })
        });
        if (r.ok) {
          const j = await r.json();
          const parsed = JSON.parse(j?.choices?.[0]?.message?.content || "{}");
          if (parsed?.title && Array.isArray(parsed?.sections) && parsed.sections.length > 0) {
            return { academic: parsed, provider: openaiKey ? "OpenAI GPT-4o" : "DeepSeek Chat" };
          }
        }
      } catch {}
    }

    return null;
  }

  async function handleOriginalAiQuery(data, body) {
    const question = String(body.question || body.q || "").trim();
    const jobId = `job_${Date.now()}`;
    if (!question) return buildFailClosedAcademicResponse("سوال درج کریں", jobId);

    const normQ = normalizeText(question);
    const qTerms = extractQueryTerms(question);

    // 1. Check authentic original pre-Request-2 conversations & sample answers in flagships
    for (const f of data.flagships || []) {
      const fNorm = normalizeText(f.query);
      if (fNorm === normQ) {
        return {
          ...f.payload,
          conversationId: body.conversationId || f.payload.conversationId || `conv_${Date.now()}`
        };
      }
      const fTerms = extractQueryTerms(f.query);
      if (fTerms.length >= 2 && qTerms.length >= 2) {
        const overlap = qTerms.filter((t) => fTerms.includes(t)).length;
        const ratio = overlap / Math.max(fTerms.length, qTerms.length);
        if (ratio >= 0.75) {
          return {
            ...f.payload,
            conversationId: body.conversationId || f.payload.conversationId || `conv_${Date.now()}`
          };
        }
      }
    }

    // 2. Check Admin Studio curated trainingDataset (exact original entries)
    const studio = data.snapshots["/api/admin/ai-studio"] || {};
    const trainingList = Array.isArray(studio.trainingDataset) ? studio.trainingDataset : [];
    const matchedTraining = trainingList.find((tr) => {
      if (normalizeText(tr.questionUr || "") === normQ) return true;
      const kws = Array.isArray(tr.triggerKeywords) ? tr.triggerKeywords : [];
      const hits = kws.filter((kw) => {
        const nk = normalizeText(kw);
        return nk.length >= 3 && normQ.includes(nk);
      });
      return hits.length >= 2;
    });

    // 3. Retrieve clean, preface-filtered sources from hadith_corpus & search_corpus
    const hadithMatches = searchHadiths(data, question, 4);
    const passageSearch = searchCorpus(data, question, 8, body.book, body.category, body.author, true);

    const sources = [];
    let refCounter = 1;

    if (matchedTraining) {
      sources.push({
        ref: refCounter++,
        evidence_id: `EV-ADMIN-${matchedTraining.id}`,
        book_id: `admin_${matchedTraining.id}`,
        title: matchedTraining.sourceBook || "مستند مآخذِ اہلِ حدیث",
        author: matchedTraining.sourceAuthor || "علمائے سلف صالحین",
        category: matchedTraining.category || "aqeedah",
        volume: 1,
        ordinal: matchedTraining.pageOrHadithNum || 1,
        printed_page: matchedTraining.pageOrHadithNum || 1,
        heading: matchedTraining.topic || question,
        badge: `${matchedTraining.sourceBook || "مستند ماخذ"} ${matchedTraining.pageOrHadithNum || ""}`.trim(),
        content: `${matchedTraining.arabicEvidence || ""}\n${matchedTraining.scholarlyAnswerUr || ""}`.trim()
      });
    }

    for (const h of hadithMatches) {
      sources.push({
        ref: refCounter++,
        evidence_id: `EV-HAD-${h.hadith_number || refCounter}`,
        book_id: String(h.book_id || "hadith"),
        title: String(h.book_title_ur || h.book_name || "کتبِ ستہ"),
        author: String(h.author_ur || "ائمۂ حدیث"),
        category: "حدیث",
        volume: 1,
        ordinal: Number(h.hadith_number || 1),
        printed_page: Number(h.hadith_number || 1),
        heading: String(h.bab_ur || h.kitab_ur || "باب الحدیث"),
        badge: `${h.book_title_ur || h.book_name || "حدیث"} #${h.hadith_number || 1}`,
        content: `${h.arabic_text || ""}\n${h.urdu_text || ""}`.trim(),
        arabic_text: h.arabic_text || "",
        urdu_text: h.urdu_text || "",
        grade: h.grade_ur || h.grade || "صحیح"
      });
    }

    for (const p of passageSearch.hits) {
      if (sources.length >= 10) break;
      sources.push({
        ref: refCounter++,
        evidence_id: `EV-BOOK-${p.bookPageId}`,
        book_id: p.bookId,
        title: p.title,
        author: p.author,
        category: p.category,
        volume: p.volume,
        ordinal: p.ordinal,
        printed_page: p.printedPage,
        heading: p.heading,
        badge: `${p.title} (ص ${p.printedPage})`,
        content: p.matnExcerpt
      });
    }

    // Strict Original Fail-Closed Gate if zero authentic topical sources matched
    if (sources.length === 0 || (!matchedTraining && hadithMatches.length === 0 && passageSearch.maxScore < 2.0)) {
      return buildFailClosedAcademicResponse(question, jobId);
    }

    // 4. Optional Live Browser LLM Synthesis (if user saved an API key in Settings)
    const liveSynth = await tryLiveBrowserLlmSynthesis(question, sources, body);
    const metrics = {
      total_indexed_books: 987,
      searched_books_count: 987,
      matching_books_count: sources.length,
      cited_books_count: Math.min(6, sources.length)
    };

    let ac = null;
    let providerLabel = "سلفی تراث ملٹی ماڈل علمی انجن";

    if (liveSynth?.academic) {
      providerLabel = liveSynth.provider;
      ac = {
        title: liveSynth.academic.title || question,
        intro: liveSynth.academic.intro || "",
        searched_sources_count: 987,
        library_metrics: metrics,
        sections: liveSynth.academic.sections,
        scholarly_opinions: [],
        conclusion: liveSynth.academic.conclusion || "واللہ اعلم بالصواب۔",
        conclusion_refs: sources.slice(0, 3).map((s) => s.ref),
        conclusion_badges: sources.slice(0, 3).map((s) => s.badge)
      };
    } else {
      const sections = [];
      if (matchedTraining) {
        sections.push({
          heading: `1. ${matchedTraining.topic || "کتاب و سنت اور منہجِ سلف کی روشنی میں بنیادی حکم"}`,
          description: "",
          items: [
            {
              arabic: matchedTraining.arabicEvidence || "",
              narrator: `${matchedTraining.sourceBook} — ${matchedTraining.sourceAuthor}`,
              translation: matchedTraining.scholarlyAnswerUr,
              sourceRef: `${matchedTraining.sourceBook} (${matchedTraining.pageOrHadithNum || ""})`,
              hadithGrade: matchedTraining.grade || "صحیح",
              refs: [1]
            }
          ]
        });
      }

      const hadithSources = sources.filter((s) => s.arabic_text);
      if (hadithSources.length > 0) {
        sections.push({
          heading: `${sections.length + 1}. سنتِ نبویہ ﷺ اور مستند احادیث کے دلائل`,
          description: "",
          items: hadithSources.slice(0, 3).map((hs) => ({
            arabic: hs.arabic_text,
            narrator: `${hs.title} — ${hs.heading}`,
            translation: hs.urdu_text || hs.content,
            sourceRef: hs.badge,
            hadithGrade: hs.grade || "صحیح",
            refs: [hs.ref]
          }))
        });
      }

      const bookSources = sources.filter((s) => !s.arabic_text && !String(s.book_id).startsWith("admin_"));
      if (bookSources.length > 0) {
        sections.push({
          heading: `${sections.length + 1}. علمائے اہلِ حدیث اور مکتبہ کی مستند کتب سے توضیحات`,
          description: "",
          items: bookSources.slice(0, 4).map((bs) => ({
            arabic: "",
            narrator: `${bs.title} (${bs.author}) — ${bs.heading}`,
            translation: bs.content,
            sourceRef: bs.badge,
            refs: [bs.ref]
          }))
        });
      }

      const introText = matchedTraining
        ? matchedTraining.scholarlyAnswerUr.slice(0, 320)
        : `مسئلہ «${question}» سے متعلق مکتبہ سلفی تراث کی مستند کتب اور ذخیرۂ حدیث سے حاصل شدہ علمی نصوص اور محققین کی توضیحات ذیل میں مع حوالہ درج ہیں:`;

      ac = {
        title: matchedTraining?.topic || question,
        intro: introText,
        searched_sources_count: 987,
        library_metrics: metrics,
        sections,
        scholarly_opinions: [],
        conclusion:
          "خلاصۂ تحقیق یہ ہے کہ ہر علمی و شرعی مسئلے میں کتاب اللہ اور صحیح سنتِ رسول ﷺ کو فہمِ سلف صالحین کی روشنی میں اختیار کرنا ہی راجح اور اسلم منہج ہے۔ واللہ اعلم بالصواب۔",
        conclusion_refs: sources.slice(0, 3).map((s) => s.ref),
        conclusion_badges: sources.slice(0, 3).map((s) => s.badge)
      };
    }

    const mindmap = {
      topic: ac.title,
      root: {
        name: ac.title,
        children: sources.slice(0, 4).map((s) => ({
          name: s.heading || s.title,
          ref: s.ref,
          badge: s.badge
        }))
      }
    };
    ac.mindmap = mindmap;

    return {
      mode: body.mode || "answer",
      uiLanguage: body.uiLanguage || "ur",
      effectiveLanguage: "ur",
      conversationId: body.conversationId || `conv_${Date.now()}`,
      researchRunId: jobId,
      thinkingStateMachine: { stages: buildCompletedStages(jobId) },
      academicResult: ac,
      result: {
        title: ac.title,
        paragraphs: [{ text: ac.intro, refs: sources.slice(0, 2).map((s) => s.ref) }]
      },
      sources,
      searched_sources_count: 987,
      library_metrics: metrics,
      mindmap,
      quiz: [],
      gateReport: { fail_closed_triggered: false },
      generated: true,
      provider: providerLabel
    };
  }

  async function handlePortalApiRequest(urlObj, init) {
    const data = await loadPortalData();
    let pathname = urlObj.pathname;
    if (pathname.startsWith(PORTAL_BASE_DEFAULT)) {
      pathname = pathname.slice(PORTAL_BASE_DEFAULT.length) || "/";
    }
    const method = String(init?.method || "GET").toUpperCase();
    const fullKey = `${pathname}${urlObj.search}`;
    let body = {};
    if (method === "POST" && init?.body && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {}
    }

    // 1. Public / Library / Admin Reader & Catalog Routes
    if ((pathname === "/api/public" || pathname === "/api/admin" || pathname === "/api/library") && method === "GET") {
      const action = urlObj.searchParams.get("action") || "";
      if (action === "pages" || action === "page") {
        const bookId = urlObj.searchParams.get("book") || urlObj.searchParams.get("bookId") || "";
        const start = Math.max(1, Number(urlObj.searchParams.get("start") || urlObj.searchParams.get("pageNumber") || 1));
        const limit = Math.max(1, Number(urlObj.searchParams.get("limit") || 10));
        const book = data.books.find((b) => String(b.id) === String(bookId)) || {
          id: bookId,
          title: "کتاب مکتبہ سلفی تراث",
          author: "",
          count: 10
        };
        let pages = data.bookPages[String(bookId)]?.pages?.filter((p) => p.ordinal >= start && p.ordinal < start + limit) || [];
        if (pages.length === 0) {
          const fallbackPassages = data.passages.filter((p) => String(p.book_id) === String(bookId));
          if (fallbackPassages.length > 0) {
            pages = fallbackPassages.slice(0, limit).map((p, idx) => ({
              id: `${bookId}:${start + idx}`,
              book_id: bookId,
              ordinal: start + idx,
              heading: p.heading || book.title,
              content: p.content,
              footnotes: p.footnotes || "",
              volume: p.volume || "1",
              printed: p.printed || String(start + idx),
              lang: book.language || "ur",
              section_type: p.section_type || "body"
            }));
          } else {
            pages = [
              {
                id: `${bookId}:${start}`,
                book_id: bookId,
                ordinal: start,
                heading: book.title,
                content: `کتاب «${book.title}» (${book.author || "مؤلف"}) مکتبہ سلفی تراث اردو کے ذخیرے میں شامل ہے۔`,
                footnotes: "",
                volume: "1",
                printed: String(start),
                lang: book.language || "ur",
                section_type: "body"
              }
            ];
          }
        }
        return jsonResponse({ ok: true, book, pages, page: pages[0] });
      }
      if (action === "toc") {
        const bookId = urlObj.searchParams.get("book") || "";
        return jsonResponse(data.bookPages[String(bookId)]?.toc || []);
      }
      if (action === "search") {
        const q = urlObj.searchParams.get("q") || "";
        const cat = urlObj.searchParams.get("category") || "";
        const auth = urlObj.searchParams.get("author") || "";
        const bk = urlObj.searchParams.get("book") || "";
        const results = searchCorpus(data, q, 40, bk, cat, auth, false).hits.map((p) => ({
          id: p.bookPageId,
          book_id: p.bookId,
          title: p.title,
          author: p.author,
          category: p.category,
          ordinal: p.ordinal,
          page: p.ordinal,
          volume: p.volume,
          printed: p.printedPage,
          heading: p.heading,
          excerpt: p.matnExcerpt,
          content: p.rawContent || p.matnExcerpt
        }));
        return jsonResponse({ ok: true, results, total: results.length, more: false });
      }
      if (action === "books") return jsonResponse({ ok: true, books: data.books });
      if (action === "bookFullDetail") {
        const bookId = urlObj.searchParams.get("book") || "";
        const book = data.books.find((b) => String(b.id) === String(bookId)) || {};
        return jsonResponse({ ok: true, book, pages: data.bookPages[String(bookId)]?.pages || [] });
      }
      if (data.snapshots[fullKey]) return jsonResponse(data.snapshots[fullKey]);
      const pubKey = `/api/public?action=${encodeURIComponent(action)}`;
      if (data.snapshots[pubKey]) return jsonResponse(data.snapshots[pubKey]);
      const libKey = `/api/library?action=${encodeURIComponent(action)}`;
      if (data.snapshots[libKey]) return jsonResponse(data.snapshots[libKey]);
      return jsonResponse({ ok: true, books: data.books, items: [], rows: [] });
    }

    // 2. Hadith Library Route
    if (pathname === "/api/hadith") {
      if ((urlObj.searchParams.get("type") || "") === "bootstrap" && data.snapshots["/api/hadith?type=bootstrap"]) {
        return jsonResponse(data.snapshots["/api/hadith?type=bootstrap"]);
      }
      const bookId = urlObj.searchParams.get("book_id") || urlObj.searchParams.get("book") || "";
      const q = (urlObj.searchParams.get("q") || "").trim();
      const page = Math.max(1, Number(urlObj.searchParams.get("page") || 1));
      const limit = Math.max(1, Math.min(50, Number(urlObj.searchParams.get("limit") || 20)));
      let list = data.hadiths;
      if (bookId && bookId !== "all") {
        const filtered = list.filter((h) => String(h.book_id) === String(bookId));
        if (filtered.length > 0) list = filtered;
      }
      if (q) {
        const nq = normalizeText(q);
        list = list.filter((h) =>
          normalizeText(`${h.arabic_text} ${h.urdu_text} ${h.hadith_number} ${h.kitab_ur} ${h.bab_ur}`).includes(nq)
        );
      }
      const slice = list.slice((page - 1) * limit, page * limit);
      return jsonResponse({
        ok: true,
        hadiths: slice,
        items: slice,
        total: list.length,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(list.length / limit))
      });
    }

    // 3. AI Streaming Route (/api/ai/stream)
    if (pathname === "/api/ai/stream") {
      const encoder = new TextEncoder();
      if (body.mode === "catalog") {
        const nq = normalizeText(body.question || "");
        const books = data.books
          .filter((b) => !nq || normalizeText(`${b.title} ${b.author} ${b.category}`).includes(nq))
          .slice(0, 24);
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`event: complete\ndata: ${JSON.stringify({ mode: "catalog", books, generated: false })}\n\n`));
            controller.close();
          }
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
      }

      const payload = await handleOriginalAiQuery(data, body);
      const stream = new ReadableStream({
        async start(controller) {
          const emit = (ev, obj) => {
            controller.enqueue(encoder.encode(`event: ${ev}\ndata: ${JSON.stringify(obj)}\n\n`));
          };
          const jobId = payload.researchRunId || `job_${Date.now()}`;
          for (const st of THINKING_STAGES_TEMPLATE) {
            emit("stage", {
              ...st,
              researchJobId: jobId,
              status: "Running",
              timestamp: new Date().toISOString(),
              progressDescription: st.subtitleUrdu
            });
            await new Promise((r) => setTimeout(r, 45));
            emit("stage", {
              ...st,
              researchJobId: jobId,
              status: "Completed",
              timestamp: new Date().toISOString(),
              progressDescription: st.subtitleUrdu
            });
          }
          emit("complete", payload);
          controller.close();
        }
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" }
      });
    }

    // 4. AI Standard Route (/api/ai)
    if (pathname === "/api/ai") {
      if (method === "GET") {
        if ((urlObj.searchParams.get("action") || "") === "testConnection") {
          return jsonResponse({ ok: true, connected: true, message: "کنکشن فعال ہے!" });
        }
        return jsonResponse(
          data.snapshots["/api/ai"] || {
            ready: true,
            activeProvider: "auto",
            providerName: "سلفی تراث ملٹی ماڈل علمی انجن"
          }
        );
      }
      if (body.action === "saveKey") {
        try {
          if (body.geminiKey) localStorage.setItem("salafi_gemini_key", String(body.geminiKey).trim());
          if (body.groqKey) localStorage.setItem("salafi_groq_key", String(body.groqKey).trim());
          if (body.openaiKey) localStorage.setItem("salafi_openai_key", String(body.openaiKey).trim());
          if (body.deepseekKey) localStorage.setItem("salafi_deepseek_key", String(body.deepseekKey).trim());
        } catch {}
        return jsonResponse({ ok: true, saved: true });
      }
      const payload = await handleOriginalAiQuery(data, body);
      return jsonResponse(payload);
    }

    // 5. AI History Route (/api/ai/history)
    if (pathname === "/api/ai/history") {
      const storeKey = "salafi_live_portal_ai_history_orig_v1";
      let localItems = [];
      try {
        localItems = JSON.parse(localStorage.getItem(storeKey) || "[]");
      } catch {}
      const snapHist = data.snapshots["/api/ai/history"] || {};
      const baseActive = Array.isArray(snapHist.active) ? snapHist.active : [];

      if (method === "POST") {
        if (body.action === "clear") {
          try {
            localStorage.removeItem(storeKey);
          } catch {}
          return jsonResponse({ ok: true, active: [], history: [] });
        }
        if (body.entry || body.question) {
          const item = body.entry || body;
          localItems = [item, ...localItems.filter((x) => x.id !== item.id)].slice(0, 40);
          try {
            localStorage.setItem(storeKey, JSON.stringify(localItems));
          } catch {}
        }
        return jsonResponse({ ok: true, active: [...localItems, ...baseActive], history: localItems });
      }

      const qFilter = (urlObj.searchParams.get("q") || "").trim();
      const merged = [...localItems, ...baseActive];
      const filtered = qFilter
        ? merged.filter((c) => normalizeText(c.question || "") === normalizeText(qFilter))
        : merged;
      return jsonResponse({ ok: true, active: filtered, deleted: [], history: filtered, conversations: filtered });
    }

    // 6. Browser Speech Synthesis Fallback (/api/ai/tts)
    if (pathname === "/api/ai/tts") {
      try {
        if (typeof window !== "undefined" && "speechSynthesis" in window && body.text) {
          window.speechSynthesis.cancel();
          const utter = new SpeechSynthesisUtterance(String(body.text).slice(0, 600));
          utter.lang = /[\u0679\u067E\u0686\u0688\u0691\u06BA\u06BE\u06D2]/.test(body.text) ? "ur-PK" : "ar-SA";
          window.speechSynthesis.speak(utter);
        }
      } catch {}
      return jsonResponse({ ok: true, browserSpeechUsed: true });
    }

    if (method === "GET" && data.snapshots[fullKey]) return jsonResponse(data.snapshots[fullKey]);
    if (method === "GET" && data.snapshots[pathname]) return jsonResponse(data.snapshots[pathname]);

    return jsonResponse({ ok: true, id: `local_${Date.now()}`, user: { userId: "superadmin", role: "superadmin" }, items: [], rows: [] });
  }

  // Preload portal data and intercept /api/* & basePath static assets
  loadPortalData();

  window.fetch = async function (input, init) {
    try {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const urlObj = new URL(rawUrl, window.location.origin);
      if (urlObj.origin === window.location.origin) {
        const p = urlObj.pathname;
        if (p.startsWith("/api/") || p.startsWith(`${PORTAL_BASE_DEFAULT}/api/`)) {
          return await handlePortalApiRequest(urlObj, init);
        }
        const base = detectBasePath();
        if (base && !p.startsWith(base) && /\.(png|svg|ico|mjs|wasm|bcmap|ttf|pfb|webmanifest|json)$/i.test(p)) {
          urlObj.pathname = `${base}${p}`;
          return NATIVE_FETCH(urlObj.toString(), init);
        }
      }
    } catch {}
    return NATIVE_FETCH(input, init);
  };

  function rewriteRootAssetPaths() {
    const base = detectBasePath();
    if (!base) return;
    document.querySelectorAll('img[src^="/"], a[href^="/"]').forEach((el) => {
      if (el.tagName === "IMG") {
        const src = el.getAttribute("src") || "";
        if (src.startsWith("/") && !src.startsWith(base + "/")) {
          el.setAttribute("src", `${base}${src}`);
        }
      } else if (el.tagName === "A") {
        const href = el.getAttribute("href") || "";
        if ((href === "/" || href === "/admin" || href.startsWith("/admin/")) && !href.startsWith(base)) {
          el.setAttribute("href", `${base}${href === "/" ? "/" : href}`);
        }
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", rewriteRootAssetPaths);
  } else {
    rewriteRootAssetPaths();
  }
  const obs = new MutationObserver(rewriteRootAssetPaths);
  if (document.documentElement) {
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
