import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getServiceSupabase } from '@/lib/supabase';
import { buildSystemPrompt, PHASES } from '@/lib/phases';
import { TOOLS, executeTool } from '@/lib/tools';

export const maxDuration = 60;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Modèle pour le chat (questions/réponses) — Haiku = 4x moins cher
const CHAT_MODEL = 'claude-haiku-4-5-20251001';

// Pricing Claude Haiku 4.5 en micro-dollars par token
const COST_INPUT_MICRO = 0.80;       // $0.80/M — input normal
const COST_CACHE_WRITE_MICRO = 1.00; // $1/M — écriture cache
const COST_CACHE_READ_MICRO = 0.08;  // $0.08/M — lecture cache
const COST_OUTPUT_MICRO = 4;         // $4/M — output

function calculateCostMicro(usage) {
  // Selon la doc Anthropic, les champs usage sont INDÉPENDANTS :
  // - input_tokens : tokens après le dernier cache breakpoint (non-cachés)
  // - cache_creation_input_tokens : tokens écrits dans le cache
  // - cache_read_input_tokens : tokens lus depuis le cache
  // Chacun doit être facturé à son propre tarif, sans soustraction.
  const inputTokens = usage?.input_tokens || 0;
  const outputTokens = usage?.output_tokens || 0;
  const cacheWriteTokens = usage?.cache_creation_input_tokens || 0;
  const cacheReadTokens = usage?.cache_read_input_tokens || 0;

  return Math.round(
    inputTokens * COST_INPUT_MICRO +
    cacheWriteTokens * COST_CACHE_WRITE_MICRO +
    cacheReadTokens * COST_CACHE_READ_MICRO +
    outputTokens * COST_OUTPUT_MICRO
  );
}

// Budget tokens pour les messages récents (hors system prompt)
// Haiku 4.5 = 200K tokens context window. Pas de contrainte de taille.
// On limite l'historique pour contrôler le COÛT (input tokens facturés).
// System prompt + résumés ≈ 2000-5000 tokens selon les phases complétées.
// ~10 000 tokens d'historique ≈ ~0.008$ par message (input Haiku = $0.80/M)
const MAX_HISTORY_TOKENS = 10000;

// Estimation grossière : 1 token ≈ 4 caractères en français
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// ── Retry avec exponential backoff ──
async function callAnthropicWithRetry(params, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      if (err.status === 429 && i < maxRetries - 1) {
        const wait = Math.pow(2, i) * 1500 + Math.random() * 500;
        console.log(`[Rate Limit] Retry ${i + 1}/${maxRetries} dans ${Math.round(wait)}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

// ── Sélectionner les messages récents en respectant un budget de tokens ──
// On prend les messages les plus récents jusqu'à remplir le budget.
function selectRecentByTokens(messages, maxTokens) {
  const selected = [];
  let totalTokens = 0;

  // Parcourir du plus récent au plus ancien
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(messages[i].content);
    if (totalTokens + msgTokens > maxTokens && selected.length > 0) break;
    selected.unshift(messages[i]);
    totalTokens += msgTokens;
  }

  return { selected, totalTokens, skipped: messages.length - selected.length };
}

// ── Construire les messages avec budget tokens ──
// Les résumés de phases sont déjà injectés dans le system prompt (summaryBlock).
// Ici on gère uniquement l'historique de conversation récent + note de reprise.
function buildSmartMessages(allMessages, phaseSummaries, isReturningSession = false) {
  // Note de reprise de session si le client revient après une pause
  const returningMessage = isReturningSession
    ? [{
        role: 'user',
        content: `[NOTE SYSTÈME : Le client revient après une pause (heures/jours). Accueille-le brièvement en lui rappelant où vous en étiez et sur quelle phase vous allez continuer. Ne refais PAS tout le résumé, juste 1-2 phrases de contexte. Les résumés des phases sont dans tes instructions système.]`,
      }]
    : [];

  // Calculer le budget restant après la note de reprise
  const returningTokens = returningMessage.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const availableTokens = MAX_HISTORY_TOKENS - returningTokens;

  // Sélectionner les messages récents qui tiennent dans le budget
  const { selected, skipped } = selectRecentByTokens(allMessages, availableTokens);

  if (skipped > 0) {
    const skipMessage = {
      role: 'user',
      content: `[${skipped} messages précédents omis — les informations clés sont dans les résumés de phase dans les instructions système.]`,
    };
    return [...returningMessage, skipMessage, ...selected];
  }

  return [...returningMessage, ...selected];
}

// ── Générer un résumé de phase (appel léger) ──
async function generatePhaseSummary(sb, projectId, phaseId, allMessages) {
  const phaseName = PHASES.find(p => p.id === phaseId)?.name || `Phase ${phaseId}`;

  // Prendre les derniers messages pertinents (ceux de cette phase)
  const recentConv = allMessages.slice(-50)
    .map(m => `${m.role === 'user' ? 'CLIENT' : 'BRIEFBOT'}: ${m.content}`)
    .join('\n');

  try {
    const response = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Résume en bullet points TOUTES les informations clés collectées pendant la Phase ${phaseId} — ${phaseName} de ce briefing.

RÈGLES :
- Reprends CHAQUE information concrète : noms, chiffres, URLs, villes, dates, budgets
- Format : bullet points concis mais exhaustifs
- Ne mets PAS de commentaires ou recommandations, uniquement les FAITS collectés
- Si le client a donné un chiffre ou un nom, il DOIT apparaître
- Si le client a CORRIGÉ une information précédemment donnée, utilise la version CORRIGÉE (la plus récente)
- Français uniquement

Conversation récente :
${recentConv.substring(0, 8000)}`
      }],
    });

    const summary = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    // Coût du résumé
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    const costMicro = calculateCostMicro(response.usage);

    await sb.rpc('increment_project_cost', { project_id: projectId, amount: costMicro });
    await sb.rpc('increment_project_tokens', { project_id: projectId, amount: inputTokens + outputTokens });

    // Sauvegarder le résumé dans le projet
    const { data: proj } = await sb
      .from('projects')
      .select('phase_summaries')
      .eq('id', projectId)
      .single();

    const existingSummaries = proj?.phase_summaries || {};
    existingSummaries[String(phaseId)] = summary;

    await sb
      .from('projects')
      .update({ phase_summaries: existingSummaries })
      .eq('id', projectId);

    console.log(`[Phase Summary] Phase ${phaseId} résumée (${summary.length} chars, coût: ${costMicro}µ$)`);

    return summary;
  } catch (err) {
    console.error(`[Phase Summary] Erreur résumé phase ${phaseId}:`, err.message);
    return null;
  }
}

export async function POST(request) {
  try {
    const { projectId, message, mode } = await request.json();

    if (!projectId || !message) {
      return NextResponse.json({ error: 'projectId et message requis' }, { status: 400 });
    }

    const sb = getServiceSupabase();

    const { data: project, error: projErr } = await sb
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (projErr || !project) {
      return NextResponse.json({ error: 'Projet non trouvé' }, { status: 404 });
    }

    const currentCost = project.cost_micro_usd || 0;
    const budget = project.budget_micro_usd || 5000000;
    if (currentCost >= budget) {
      return NextResponse.json({
        error: 'Budget atteint pour ce projet.',
        limit_reached: true,
        cost_usd: currentCost / 1000000,
        budget_usd: budget / 1000000,
      }, { status: 429 });
    }

    // Sauvegarder le message utilisateur
    await sb.from('messages').insert({
      project_id: projectId,
      role: 'user',
      content: message,
      mode: mode || 'client',
    });

    // Récupérer l'historique
    const { data: history } = await sb
      .from('messages')
      .select('role, content, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true });

    // Détecter si c'est une reprise de session (dernier message > 1h)
    const previousMessages = (history || []).slice(0, -1); // sans le message qu'on vient d'insérer
    const lastMsgTime = previousMessages.length > 0
      ? new Date(previousMessages[previousMessages.length - 1].created_at).getTime()
      : null;
    const isReturningSession = lastMsgTime && (Date.now() - lastMsgTime > 60 * 60 * 1000);

    // Messages pour l'API Claude (sans created_at)
    const allMessages = (history || []).map(m => ({
      role: m.role,
      content: m.content,
    }));

    // Construire les messages intelligemment :
    // résumés des phases complétées + messages récents uniquement
    const apiMessages = buildSmartMessages(allMessages, project.phase_summaries, isReturningSession);

    const systemPrompt = buildSystemPrompt(project, mode || 'client');

    // ── Boucle tool use ──
    let totalCostMicro = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let loopMessages = [...apiMessages];
    let maxIterations = 5;

    // Plus de tokens pour le premier message avec contexte initial (analyse des phases)
    const isFirstWithContext = allMessages.length <= 2 && project.context;
    const maxTokens = isFirstWithContext ? 4000 : 1500;

    let response = await callAnthropicWithRetry({
      model: CHAT_MODEL,
      max_tokens: maxTokens,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        }
      ],
      messages: loopMessages,
      tools: TOOLS,
    });

    totalCostMicro += calculateCostMicro(response.usage);
    totalInputTokens += response.usage?.input_tokens || 0;
    totalOutputTokens += response.usage?.output_tokens || 0;

    let iterations = 0;
    while (response.stop_reason === 'tool_use' && iterations < maxIterations) {
      iterations++;

      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        console.log(`[Tool Use] ${toolUse.name}(${JSON.stringify(toolUse.input)})`);
        const result = await executeTool(toolUse.name, toolUse.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result).substring(0, 15000),
        });
      }

      loopMessages.push({ role: 'assistant', content: response.content });
      loopMessages.push({ role: 'user', content: toolResults });

      response = await callAnthropicWithRetry({
        model: CHAT_MODEL,
        max_tokens: 1500,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          }
        ],
        messages: loopMessages,
        tools: TOOLS,
      });

      totalCostMicro += calculateCostMicro(response.usage);
      totalInputTokens += response.usage?.input_tokens || 0;
      totalOutputTokens += response.usage?.output_tokens || 0;
    }

    // Extraire le texte final
    const aiText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    const totalTokens = totalInputTokens + totalOutputTokens;

    const { data: newCostMicro, error: costRpcErr } = await sb.rpc('increment_project_cost', {
      project_id: projectId,
      amount: totalCostMicro,
    });

    await sb.rpc('increment_project_tokens', {
      project_id: projectId,
      amount: totalTokens,
    });

    const actualCostMicro = costRpcErr ? currentCost + totalCostMicro : newCostMicro;

    // Sauvegarder la réponse
    await sb.from('messages').insert({
      project_id: projectId,
      role: 'assistant',
      content: aiText,
      mode: mode || 'client',
    });

    // Détecter la complétion de phase → capturer TOUTES les phases complétées
    const phaseMatches = [...aiText.matchAll(/✅\s*Phase\s*(\d+)/g)];
    const currentPhases = project.phases_completed || [];
    let updatedPhases = [...currentPhases];
    let newCurrentPhase = project.current_phase ?? 0;

    if (phaseMatches.length > 0) {
      for (const match of phaseMatches) {
        const completedId = parseInt(match[1]);
        if (!updatedPhases.includes(completedId)) {
          updatedPhases.push(completedId);
        }

        // Générer un résumé pour chaque phase complétée
        generatePhaseSummary(sb, projectId, completedId, allMessages)
          .catch(err => console.error(`[Phase Summary] Background error phase ${completedId}:`, err));
      }

      // Trouver la prochaine phase non complétée
      const allPhaseIds = PHASES.map(p => p.id);
      const nextUncompleted = allPhaseIds.find(id => id > 0 && !updatedPhases.includes(id));
      newCurrentPhase = nextUncompleted !== undefined ? nextUncompleted : 11;
    }

    // Détecter aussi quand l'IA indique être sur une phase [Phase X — ...]
    const phaseIndicator = aiText.match(/\[Phase\s*(\d+)\s*[—–-]/);
    if (phaseIndicator) {
      const indicatedPhase = parseInt(phaseIndicator[1]);
      if (indicatedPhase !== newCurrentPhase) {
        newCurrentPhase = indicatedPhase;
      }
    }

    // Si le client fait des corrections sur une phase déjà complétée,
    // régénérer le résumé pour intégrer les nouvelles infos
    if (!phaseMatch && phaseIndicator) {
      const indicatedPhase = parseInt(phaseIndicator[1]);
      if (updatedPhases.includes(indicatedPhase)) {
        generatePhaseSummary(sb, projectId, indicatedPhase, allMessages)
          .catch(err => console.error('[Phase Summary] Background re-summary error:', err));
      }
    }

    // Si l'IA confirme qu'une phase est déjà complétée (revisitée),
    // s'assurer qu'elle est bien dans phases_completed
    const alreadyDoneMatch = aiText.match(/[Pp]hase\s*(\d+).*(?:déjà complétée|déjà été couverte|déjà abordée|déjà collecté)/);
    if (alreadyDoneMatch) {
      const doneId = parseInt(alreadyDoneMatch[1]);
      if (!updatedPhases.includes(doneId)) {
        updatedPhases.push(doneId);
      }
    }

    // Résumé intermédiaire : si la phase en cours n'est pas complétée
    // et que la conversation dépasse le budget tokens, générer un résumé provisoire
    // pour ne pas perdre d'infos quand la fenêtre tronque les vieux messages
    const totalHistoryTokens = allMessages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    if (!phaseMatch && totalHistoryTokens > MAX_HISTORY_TOKENS) {
      const existingSummaries = project.phase_summaries || {};
      const currentPhaseId = newCurrentPhase;
      if (!existingSummaries[String(currentPhaseId)]) {
        // Pas encore de résumé pour cette phase → en générer un
        generatePhaseSummary(sb, projectId, currentPhaseId, allMessages)
          .catch(err => console.error('[Phase Summary] Background interim summary error:', err));
      } else if (totalHistoryTokens > MAX_HISTORY_TOKENS * 2) {
        // Le résumé existe mais la conversation a beaucoup grandi → régénérer
        generatePhaseSummary(sb, projectId, currentPhaseId, allMessages)
          .catch(err => console.error('[Phase Summary] Background re-summary error:', err));
      }
    }

    // Mettre à jour le projet si quelque chose a changé
    if (updatedPhases.length !== currentPhases.length || newCurrentPhase !== (project.current_phase ?? 0)) {
      await sb
        .from('projects')
        .update({
          phases_completed: updatedPhases,
          current_phase: newCurrentPhase,
        })
        .eq('id', projectId);
    }

    return NextResponse.json({
      content: aiText,
      current_phase: newCurrentPhase,
      phases_completed: updatedPhases,
      cost_usd: actualCostMicro / 1000000,
      budget_usd: budget / 1000000,
      cost_this_message_usd: totalCostMicro / 1000000,
      tokens_used: totalTokens,
      tokens_this_message: totalTokens,
      tokens_input: totalInputTokens,
      tokens_output: totalOutputTokens,
      tools_used: iterations > 0,
    });
  } catch (err) {
    console.error('Chat API error:', err);

    if (err.status === 429) {
      return NextResponse.json(
        { error: 'L\'API Claude est temporairement surchargée. Réessayez dans quelques secondes.' },
        { status: 429 }
      );
    }

    return NextResponse.json(
      { error: 'Erreur serveur : ' + (err.message || 'Inconnue') },
      { status: 500 }
    );
  }
}
