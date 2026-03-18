import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getServiceSupabase } from '@/lib/supabase';
import { buildExportPrompt } from '@/lib/phases';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Retry avec backoff pour les erreurs 429
async function callWithRetry(params, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      if (err.status === 429 && i < maxRetries - 1) {
        const wait = Math.pow(2, i) * 2000 + Math.random() * 500;
        console.log(`[Export Rate Limit] Retry ${i + 1}/${maxRetries} dans ${Math.round(wait)}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

export async function POST(request) {
  try {
    const { projectId, password, format = 'doc' } = await request.json();

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
        cost_usd: currentCost / 1000000,
        budget_usd: budget / 1000000,
      }, { status: 429 });
    }

    // Récupérer tous les messages
    const { data: messages } = await sb
      .from('messages')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true });

    if (!messages || messages.length < 2) {
      return NextResponse.json({ error: 'Pas assez de messages pour générer un export' }, { status: 400 });
    }

    // Construire le prompt d'export (avec troncature intégrée)
    const exportPrompt = buildExportPrompt(project, messages);

    const response = await callWithRetry({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: exportPrompt }],
    });

    let htmlContent = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;

    // Calculer et enregistrer le coût
    const costMicro = inputTokens * 3 + outputTokens * 15;
    await sb.rpc('increment_project_cost', {
      project_id: projectId,
      amount: costMicro,
    });
    await sb.rpc('increment_project_tokens', {
      project_id: projectId,
      amount: inputTokens + outputTokens,
    });

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
