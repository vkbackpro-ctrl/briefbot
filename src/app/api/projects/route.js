import { NextResponse } from 'next/server';
import { getServiceSupabase } from '@/lib/supabase';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const password = searchParams.get('pw');

  if (password !== process.env.CONSULTANT_PASSWORD) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  }

  const sb = getServiceSupabase();
  const { data, error } = await sb
    .from('projects')
    .select('id, name, client_name, url, context, current_phase, phases_completed, share_token, tokens_used, tokens_limit, cost_micro_usd, budget_micro_usd, created_at, updated_at')
    .order('updated_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ projects: data });
}

export async function POST(request) {
  const { name, client_name, url, context, tokens_limit, budget_usd, password } = await request.json();

  if (password !== process.env.CONSULTANT_PASSWORD) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  }

  if (!name || !client_name) {
    return NextResponse.json({ error: 'name et client_name requis' }, { status: 400 });
  }

  const sb = getServiceSupabase();
  // Budget en micro-dollars : $1 = 1 000 000
  const budgetMicro = budget_usd ? Math.round(budget_usd * 1000000) : 5000000; // $5 par défaut

  const { data, error } = await sb
    .from('projects')
    .insert({
      name,
      client_name,
      url: url || '',
      context: context || '',
      tokens_limit: tokens_limit || 1000000,
      budget_micro_usd: budgetMicro,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ project: data });
}

export async function PATCH(request) {
  const { projectId, tokens_limit, budget_usd, password } = await request.json();

  if (password !== process.env.CONSULTANT_PASSWORD) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  }

  const updates = {};
  if (tokens_limit) updates.tokens_limit = tokens_limit;
  if (budget_usd) updates.budget_micro_usd = Math.round(budget_usd * 1000000);

  const sb = getServiceSupabase();
  const { data, error } = await sb
    .from('projects')
    .update(updates)
    .eq('id', projectId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ project: data });
}

export async function DELETE(request) {
  const { projectId, password } = await request.json();

  if (password !== process.env.CONSULTANT_PASSWORD) {
    return NextResponse.json({ error: 'Non autorisé' }, { status: 401 });
  }

  const sb = getServiceSupabase();
  const { error } = await sb.from('projects').delete().eq('id', projectId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
