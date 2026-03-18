import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getServiceSupabase } from '@/lib/supabase';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

async function callWithRetry(params, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      if (err.status === 429 && i < maxRetries - 1) {
        const wait = Math.pow(2, i) * 2000 + Math.random() * 500;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

// Tronquer la conversation pour rester sous les limites
function truncateConversation(messages) {
  let text = messages
    .map(m => `${m.role === "user" ? (m.mode === "consultant" ? "CONSULTANT" : "CLIENT") : "BRIEFBOT"}: ${m.content}`)
    .join("\n\n");

  const MAX = 25000;
  if (text.length > MAX) {
    const keepStart = Math.floor(MAX * 0.4);
    const keepEnd = Math.floor(MAX * 0.5);
    text = text.substring(0, keepStart)
      + `\n\n[... contenu intermédiaire omis ...]\n\n`
      + text.substring(text.length - keepEnd);
  }
  return text;
}

// 3 sections du document, chacune tient dans le timeout de 10s
const SECTIONS = [
  {
    id: 'part1',
    label: 'Partie 1/3',
    prompt: (project, conv) => `Tu es un expert en rédaction de briefs stratégiques. Génère en HTML les sections suivantes du document de briefing à partir de la conversation.

GÉNÈRE UNIQUEMENT ces sections (HTML pur, pas de balises html/head/body) :
1. <h1>Page de garde</h1> — nom du projet "${project.name}", client "${project.client_name}", date "${new Date().toISOString().slice(0, 10)}", URL "${project.url || 'Non renseigné'}"
2. <h1>Résumé exécutif</h1> — 1 paragraphe dense synthétisant tout le projet
3. <h1>Profil de l'interlocuteur</h1> — métier, rôle, niveau digital/SEO/UX
4. <h1>Identité & Vision</h1> — histoire, mission, valeurs, vision, proposition de valeur unique. TOUS les détails.
5. <h1>Offre & Services</h1> — liste EXHAUSTIVE avec tableau si pertinent. Tarifs, rentabilité, saisonnalité.
6. <h1>Cibles & Personas</h1> — fiches personas détaillées. Chaque segment avec profil, motivations, freins, part de CA.

RÈGLES : Sois EXHAUSTIF. Reprends CHAQUE info, chiffre, nom de la conversation. Cite le client entre guillemets. Français uniquement. Utilise h1, h2, h3, p, table, ul, blockquote, strong.

${project.context ? `Contexte initial : ${project.context.substring(0, 1500)}\n` : ""}
Conversation :
${conv}`,
  },
  {
    id: 'part2',
    label: 'Partie 2/3',
    prompt: (project, conv) => `Tu es un expert en rédaction de briefs stratégiques. Génère en HTML les sections suivantes du document de briefing à partir de la conversation.

GÉNÈRE UNIQUEMENT ces sections (HTML pur) :
7. <h1>Concurrence & Mots-clés</h1> — TOUS les concurrents mentionnés (noms, URLs), TOUS les mots-clés, zone géographique, résultats SERP si mentionnés.
8. <h1>Analyse SWOT</h1> — tableau 2×2 complet avec CHAQUE point identifié.
9. <h1>Tonalité & Univers de marque</h1> — personnalité, registre, adjectifs, couleurs, inspirations.
10. <h1>Parcours utilisateur & UX</h1> — parcours idéal par persona, actions prioritaires, fonctionnalités, irritants.
11. <h1>Objectifs business & SEO</h1> — objectifs chiffrés, KPIs, budget, canaux, mots-clés stratégiques.

RÈGLES : Sois EXHAUSTIF. Reprends CHAQUE info, chiffre, nom. Cite le client. Français uniquement.

${project.context ? `Contexte initial : ${project.context.substring(0, 1500)}\n` : ""}
Conversation :
${conv}`,
  },
  {
    id: 'part3',
    label: 'Partie 3/3',
    prompt: (project, conv) => `Tu es un expert en rédaction de briefs stratégiques. Génère en HTML les sections suivantes du document de briefing à partir de la conversation.

GÉNÈRE UNIQUEMENT ces sections (HTML pur) :
12. <h1>Contenus & Storytelling</h1> — histoires marquantes, témoignages, cas d'usage, contenu existant, stratégie éditoriale.
13. <h1>Éléments existants & Contraintes</h1> — site actuel, ce qui marche/marche pas, CMS, outils, budget, délais.
14. <h1>Données SEO complémentaires</h1> — données SERP et analyses de sites collectées pendant le briefing.
15. <h1>Recommandations stratégiques</h1> — recommandations concrètes classées par priorité, chacune justifiée.
16. <h1>Prochaines étapes</h1> — roadmap avec étapes, livrables et timeline.

Si une section n'a pas été abordée : "⚠️ Section non abordée — À compléter".

RÈGLES : Sois EXHAUSTIF. Reprends CHAQUE info. Cite le client. Français uniquement.

${project.context ? `Contexte initial : ${project.context.substring(0, 1500)}\n` : ""}
Conversation :
${conv}`,
  },
];

// GET : lister les exports d'un projet ou re-télécharger un export
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get('projectId');
    const exportId = searchParams.get('exportId');
    const password = searchParams.get('pw');
    const format = searchParams.get('format') || 'doc';

    if (password !== process.env.CONSULTANT_PASSWORD) {
      return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
    }

    const sb = getServiceSupabase();

    // Re-télécharger un export spécifique
    if (exportId) {
      const { data: exp } = await sb
        .from('exports')
        .select('*, projects(client_name)')
        .eq('id', exportId)
        .single();

      if (!exp) {
        return NextResponse.json({ error: 'Export non trouvé' }, { status: 404 });
      }

      return buildDocResponse(exp.html_content, { client_name: exp.projects.client_name }, format);
    }

    // Lister les exports d'un projet
    if (projectId) {
      const { data: exports } = await sb
        .from('exports')
        .select('id, format, created_at')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false });

      return NextResponse.json({ exports: exports || [] });
    }

    return NextResponse.json({ error: 'projectId ou exportId requis' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { projectId, password, format = 'doc', part, action, htmlContent } = await request.json();

    // ── Action save : sauvegarder un export assemblé ──
    if (action === 'save' && htmlContent) {
      if (password !== process.env.CONSULTANT_PASSWORD) {
        return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
      }
      const sb = getServiceSupabase();
      const { data, error } = await sb
        .from('exports')
        .insert({ project_id: projectId, format, html_content: htmlContent })
        .select('id, created_at')
        .single();

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ saved: true, export_id: data.id, created_at: data.created_at });
    }

    if (!projectId) {
      return NextResponse.json({ error: 'projectId requis' }, { status: 400 });
    }

    if (password !== process.env.CONSULTANT_PASSWORD) {
      return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
    }

    const sb = getServiceSupabase();

    const { data: project } = await sb
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (!project) {
      return NextResponse.json({ error: 'Projet non trouvé' }, { status: 404 });
    }

    const currentCost = project.cost_micro_usd || 0;
    const budget = project.budget_micro_usd || 5000000;
    if (currentCost >= budget) {
      return NextResponse.json({
        error: 'Budget atteint pour ce projet.',
        limit_reached: true,
      }, { status: 429 });
    }

    const { data: messages } = await sb
      .from('messages')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true });

    if (!messages || messages.length < 2) {
      return NextResponse.json({ error: 'Pas assez de messages pour générer un export' }, { status: 400 });
    }

    const conversationText = truncateConversation(messages);

    // ── Mode multi-part : générer une seule section ──
    if (part !== undefined && part >= 0 && part < SECTIONS.length) {
      const section = SECTIONS[part];
      const prompt = section.prompt(project, conversationText);

      const response = await callWithRetry({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      });

      const html = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');

      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;
      const cacheWrite = response.usage?.cache_creation_input_tokens || 0;
      const cacheRead = response.usage?.cache_read_input_tokens || 0;
      const regularInput = Math.max(0, inputTokens - cacheWrite - cacheRead);
      // Pricing Sonnet : $3/M input, $3.75/M cache write, $0.30/M cache read, $15/M output
      const costMicro = Math.round(regularInput * 3 + cacheWrite * 3.75 + cacheRead * 0.30 + outputTokens * 15);

      await sb.rpc('increment_project_cost', { project_id: projectId, amount: costMicro });
      await sb.rpc('increment_project_tokens', { project_id: projectId, amount: inputTokens + outputTokens });

      return NextResponse.json({
        html,
        part,
        total_parts: SECTIONS.length,
        label: section.label,
      });
    }

    // ── Mode legacy : assembler le doc final ──
    const { htmlParts, format: fmt } = await request.json().catch(() => ({}));

    // Si htmlParts est fourni, on assemble directement
    if (htmlParts && Array.isArray(htmlParts)) {
      const htmlContent = htmlParts.join('\n\n<hr style="border:none;border-top:2px solid #e2e8f0;margin:40px 0;">\n\n');
      return buildDocResponse(htmlContent, project, format);
    }

    return NextResponse.json({ error: 'Paramètre "part" requis (0, 1 ou 2)' }, { status: 400 });
  } catch (err) {
    console.error('Export API error:', err);

    if (err.status === 429) {
      return NextResponse.json(
        { error: 'L\'API Claude est temporairement surchargée. Réessayez dans quelques secondes.' },
        { status: 429 }
      );
    }

    return NextResponse.json(
      { error: 'Erreur export : ' + (err.message || 'Inconnue') },
      { status: 500 }
    );
  }
}

function buildDocResponse(htmlContent, project, format) {
  const styles = `
  body { font-family: Calibri, sans-serif; color: #1a1a1a; line-height: 1.7; padding: 50px; max-width: 800px; margin: 0 auto; }
  h1 { color: #1e3a5f; font-size: 28px; border-bottom: 3px solid #e8913a; padding-bottom: 10px; margin-top: 40px; }
  h2 { color: #2c5282; font-size: 22px; margin-top: 30px; }
  h3 { color: #4a6fa5; font-size: 18px; }
  table { border-collapse: collapse; width: 100%; margin: 15px 0; }
  th, td { border: 1px solid #cbd5e0; padding: 10px 14px; text-align: left; }
  th { background-color: #edf2f7; color: #2d3748; font-weight: 600; }
  tr:nth-child(even) { background-color: #f7fafc; }
  ul, ol { padding-left: 24px; }
  li { margin-bottom: 6px; }
  blockquote { border-left: 4px solid #e8913a; padding: 12px 16px; background: #fef7ed; margin: 16px 0; font-style: italic; }
  .badge { display: inline-block; background: #ebf4ff; color: #2b6cb0; padding: 2px 10px; border-radius: 12px; font-size: 13px; }
  .warning { background: #fef3c7; padding: 12px 16px; border-left: 4px solid #f59e0b; margin: 16px 0; border-radius: 4px; }`;

  const filename = `Brief_${project.client_name.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}`;

  if (format === 'pdf') {
    const pdfHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${filename}</title>
<style>
  @media print { @page { margin: 15mm; } }
  ${styles}
</style></head><body>${htmlContent}</body></html>`;
    return NextResponse.json({ html: pdfHtml, filename });
  }

  const fullDoc = `\ufeff<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><style>${styles}</style></head><body>${htmlContent}</body></html>`;

  return new NextResponse(fullDoc, {
    headers: {
      'Content-Type': 'application/msword; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}.doc"`,
    },
  });
}
