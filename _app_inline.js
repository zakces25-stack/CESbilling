
'use strict';
/* ═════════════════════════════════════════════════════════════════════
   CES Sales — mobile companion app.
   Figures entry + trends + team board for brokers, installable on iOS
   and Android. All business logic below is ported VERBATIM (or with the
   noted, behaviour-identical adaptations) from public/sales.html so the
   two clients can never disagree about a number:
     · username→email mapping, Turnstile captchaToken login
     · _SK_FIELDS, period keys ('YYYY-MM-01'), FY = July–June
     · effective figures merge (broker_kpis + team_sales + broker_sales)
     · contract billing / uplift / commission maths
     · save (upsert onConflict rep_id,period), lost-reason + customers-of-
       concern rules, confirm-month lock semantics
   ═════════════════════════════════════════════════════════════════════ */

/* ── constants (identical to sales.html) ── */
const SUPABASE_URL  = 'https://niadffxpxdohglcyagau.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5pYWRmZnhweGRvaGdsY3lhZ2F1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mzc3MTksImV4cCI6MjA5NDMxMzcxOX0.x22Zh9O408PGfcPZ6rgu-a4B7WTbyH8iyT_ysr-IfIs';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true }
});
const LOGIN_DOMAIN = 'portal.cesgb.com';  // usernames map to <username>@portal.cesgb.com

var currentUser = null;
var _SK = { reps: [], kpis: [], sales: [], salesTeam: [], eff: [], targets: {}, compByRep: {}, myRepId: null, fy: null };
var _entryKey = null;      // selected period 'YYYY-MM-01' on the Figures tab
var _teamKey = '__all__';  // Team tab period ('__all__' = FY cumulative)
var _charts = {};
var _dirty = false;
var _draftTimer = null;
var _restoredDraft = false;
var _locked = false;

/* ═══════════ helpers (verbatim ports from sales.html) ═══════════ */
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
function _skMoney(n){ return '£' + (Number(n)||0).toLocaleString('en-GB', { maximumFractionDigits:0 }); }
function _skNum(n, dp){ return (Number(n)||0).toLocaleString('en-GB', { minimumFractionDigits:dp||0, maximumFractionDigits:dp||0 }); }
function _skUplift(bill, kwh){ kwh = Number(kwh)||0; if(!kwh) return '—'; return ((Number(bill)||0)/kwh*100).toFixed(2); }
function _skContractBill(k){
  k = k || {};
  if (k._contract_eff != null) return Number(k._contract_eff) || 0;
  var ov = k.uplift_override, kwh = Number(k.total_kwh) || 0;
  if (ov != null && ov !== '' && kwh) return (Number(ov) || 0) / 100 * kwh;
  return Math.max(0, (Number(k.billing_total)||0) - (Number(k.consultancy)||0));
}
function _skHasOverride(k){
  if (!k) return false;
  if (k._has_override != null) return !!k._has_override;
  return k.uplift_override != null && k.uplift_override !== '';
}
function _skPeriodLabel(p){ if(!p) return ''; var d = new Date(p + 'T00:00:00'); return d.toLocaleDateString('en-GB', { month:'short', year:'numeric' }); }
function _skCurrentFyStart(){ var d=new Date(); return (d.getMonth()>=6) ? d.getFullYear() : d.getFullYear()-1; }
function _fyStartOf(period){ var y=+String(period).slice(0,4), m=+String(period).slice(5,7); return m>=7 ? y : y-1; }
function _fyLabel(fy){ var b=String((fy+1)%100); if(b.length<2)b='0'+b; return 'FY ' + fy + '/' + b; }
function _fyMonths(fy){ var out=[]; for(var i=6;i<18;i++){ var y=fy+Math.floor(i/12), mm=(i%12)+1; out.push(y+'-'+(mm<10?'0'+mm:mm)+'-01'); } return out; }
function _skFy(){ return (_SK.fy!=null)?_SK.fy:_skCurrentFyStart(); }
function _skFyList(){ var set={}; _SK.eff.forEach(function(k){ set[_fyStartOf(k.period)]=1; }); set[_skCurrentFyStart()]=1; return Object.keys(set).map(Number).sort(function(a,b){return b-a;}); }
function _skSaleContribKwh(s){ return (Number(s.aq_kwh)||0) * ((Number(s.term_months)||12)/12); }
function _thisMonthKey(){ return new Date().toISOString().slice(0,7)+'-01'; }  // UTC basis, same as desktop

var _SK_FIELDS = [
  ['billing_total', 'Billing total', '£', 'Annual equivalent — include consultancy / direct £'],
  ['long_term_total', 'Long term total', '£', ''],
  ['consultancy', 'Consultancy / direct sales', '£', 'Shared saving, metering, fixed fees — excluded from uplift'],
  ['total_kwh', 'Total kWh', 'kWh', ''],
  ['new_business_gbp', 'Total new business', '£', ''],
  ['new_business_kwh', 'Total new business', 'kWh', ''],
  ['nb_organic_gbp', 'Organic growth', '£', ''],
  ['nb_organic_kwh', 'Organic growth', 'kWh', ''],
  ['nb_recommendation_gbp', 'Recommendation', '£', ''],
  ['nb_recommendation_kwh', 'Recommendation', 'kWh', ''],
  ['nb_prospecting_gbp', 'Prospecting', '£', ''],
  ['nb_prospecting_kwh', 'Prospecting', 'kWh', ''],
  ['lost_customers', 'Lost customers', '#', ''],
  ['lost_meters', 'Lost meters', '#', ''],
  ['lost_kwh', 'Lost kWh', 'kWh', '']
];
var _SECTIONS = [
  { title: 'Billing', fields: ['billing_total','long_term_total','consultancy','total_kwh'] },
  { title: 'New business', fields: ['new_business_gbp','new_business_kwh','nb_organic_gbp','nb_organic_kwh','nb_recommendation_gbp','nb_recommendation_kwh','nb_prospecting_gbp','nb_prospecting_kwh'] },
  { title: 'Losses', fields: ['lost_customers','lost_meters','lost_kwh'] }
];

/* ═══════════ toast / audit ═══════════ */
var _toastT = null;
function toast(msg, isErr){
  var t = document.getElementById('toast');
  t.textContent = msg; t.className = 'on' + (isErr ? ' err' : '');
  clearTimeout(_toastT); _toastT = setTimeout(function(){ t.className = ''; }, 3200);
}
async function logAction(action, targetId, metadata) {
  if (!currentUser) return;
  try {
    await sb.from('audit_log').insert({
      user_id:     currentUser.userId,
      customer_id: currentUser.customerId === '__admin__' ? null : currentUser.customerId,
      action:      action,
      target_id:   targetId || null,
      metadata:    metadata || {}
    });
  } catch (e) { console.warn('Audit log write failed for', action, e); }
}

/* ═══════════ Turnstile (same contract as sales.html) ═══════════ */
window._turnstileToken = null;
function _setLoginEnabled(on){ var b = document.getElementById('loginBtn'); if (b) b.disabled = !on; }
function onTurnstileSuccess(token){ window._turnstileToken = token; _setLoginEnabled(true); }
function onTurnstileError(){ window._turnstileToken = null; _setLoginEnabled(false); }
function onTurnstileExpired(){ window._turnstileToken = null; _setLoginEnabled(false); }

/* ═══════════ auth ═══════════ */
function _loginErr(msg, asHtml){
  var e = document.getElementById('loginErr');
  if (asHtml) e.innerHTML = msg; else e.textContent = msg;
  e.style.display = 'block';
}
async function doLogin(){
  let email = document.getElementById('loginUser').value.trim();
  if (email && email.indexOf('@') === -1) email = email + '@' + LOGIN_DOMAIN;
  const pass = document.getElementById('loginPass').value;
  document.getElementById('loginErr').style.display = 'none';
  const captchaToken = window._turnstileToken ||
    (window.turnstile && typeof turnstile.getResponse === 'function' ? turnstile.getResponse() : '');
  if (!captchaToken) {
    _loginErr('Please complete the human-verification check above. If it did not appear, turn off any content blocker for this site and reload.');
    return;
  }
  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.textContent = 'Signing in…';
  let resp;
  try {
    resp = await sb.auth.signInWithPassword({ email, password: pass, options: { captchaToken } });
  } catch (e) {
    btn.textContent = 'Sign in';
    _loginErr('Connection problem — check your signal and try again.');
    if (window.turnstile && typeof turnstile.reset === 'function') turnstile.reset();
    window._turnstileToken = null; _setLoginEnabled(false);
    return;
  }
  const { data, error } = resp;
  if (error) {
    btn.textContent = 'Sign in';
    const m = (error.message || '').toLowerCase();
    if (m.includes('captcha'))                   _loginErr('Human-verification expired — complete the check above and try again.');
    else if (m.includes('email not confirmed'))  _loginErr('This account is not confirmed yet. Please contact CES.');
    else if (m.includes('too many') || m.includes('rate limit')) _loginErr('Too many attempts — please wait a minute and try again.');
    else                                          _loginErr('Invalid username or password.');
    if (window.turnstile && typeof turnstile.reset === 'function') turnstile.reset();
    window._turnstileToken = null; _setLoginEnabled(false);
    return;
  }
  try { localStorage.setItem('cesSalesApp:lastUser', document.getElementById('loginUser').value.trim()); } catch(e){}
  btn.textContent = 'Loading…';
  await loadProfileAndEnter(data.user);
}
async function loadProfileAndEnter(user){
  let profile = null, error = null;
  try {
    const r = await sb
      .from('profiles')
      .select('*, customers!profiles_customer_id_fkey(company_name, has_logo)')
      .eq('id', user.id)
      .single();
    profile = r.data; error = r.error;
  } catch (e) { error = e; }
  if (error || !profile) {
    // Distinguish "no such profile" from "no network": a fetch failure while a
    // valid session exists must NOT sign the broker out (that would make the
    // offline snapshot unreachable). PostgREST returns PGRST116 for 0 rows.
    var noRow = error && (error.code === 'PGRST116' || /0 rows/i.test(error.message || ''));
    if (!noRow) {
      var cached = null;
      try { cached = JSON.parse(localStorage.getItem('cesSalesApp:profile') || 'null'); } catch(e){}
      if (cached && cached.userId === user.id && cached.isBroker) {
        currentUser = cached;
        enterApp();
        return;
      }
      _loginErr('Could not reach the server — check your signal and try again.');
      _resetLoginBtn();
      return;
    }
    _loginErr('Profile not found. Contact CES.');
    clearLocalData(false);
    await sb.auth.signOut();
    _resetLoginBtn();
    return;
  }
  currentUser = {
    email:      user.email,
    userId:     user.id,
    customerId: profile.customer_id || '__admin__',
    name:       profile.is_admin ? 'CES Admin'
              : profile.role === 'broker' ? 'Broker'
              : (profile.customers && profile.customers.company_name || 'Customer'),
    isAdmin:    !!profile.is_admin,
    isBroker:   profile.role === 'broker',
    role:       profile.role || 'customer',
    salesLead:  !!profile.sales_lead,
    execView:   !!profile.exec_view
  };
  // ── Sales app is broker-only (same gate as sales.html) ──
  if (!currentUser.isBroker) {
    clearLocalData(false);
    await sb.auth.signOut();
    currentUser = null;
    _loginErr('This isn\'t a sales account. Please sign in at the <a href="/">billing portal</a>.', true);
    _resetLoginBtn();
    if (window.turnstile && typeof turnstile.reset === 'function') turnstile.reset();
    window._turnstileToken = null;
    return;
  }
  try { localStorage.setItem('cesSalesApp:profile', JSON.stringify(currentUser)); } catch(e){}
  logAction('login', null, { role: currentUser.role, portal: 'sales-app' });
  enterApp();
}
function _resetLoginBtn(){ var b = document.getElementById('loginBtn'); if (b) { b.textContent = 'Sign in'; b.disabled = !window._turnstileToken; } }
function clearLocalData(inclDrafts){
  try {
    Object.keys(localStorage).forEach(function(k){
      if (k === 'cesSalesApp:snapshot' || k === 'cesSalesApp:profile') localStorage.removeItem(k);
      if (inclDrafts && k.indexOf('cesSalesApp:draft:') === 0) localStorage.removeItem(k);
    });
  } catch(e){}
}
async function doLogout(){
  if (!confirm('Sign out of CES Sales?')) return;
  try { await sb.auth.signOut(); } catch(e){}
  clearLocalData(true);
  location.reload();
}

/* ═══════════ data (subset of salesFetchAll — same queries, same merge) ═══════════ */
async function refreshAll(showToast){
  try {
    var reps = await sb.from('sales_reps').select('*').order('sort_order');
    if (reps.error) throw reps.error;
    _SK.reps = (reps.data || []).filter(function(r){ return r.active !== false; });
    var kp = await sb.from('broker_kpis').select('*');
    if (kp.error) throw kp.error;
    _SK.kpis = kp.data || [];
    var degraded = false;
    var sl = await sb.from('broker_sales').select('*');
    if (sl.error) degraded = true; else _SK.sales = sl.data || [];
    var slt = await sb.rpc('team_sales');   // masked team read: revenue/kWh only
    if (slt.error) degraded = true; else _SK.salesTeam = slt.data || [];
    var tg = await sb.from('broker_targets').select('*');
    if (tg.error) degraded = true;
    else { _SK.targets = {}; (tg.data||[]).forEach(function(t){ _SK.targets[t.rep_id] = t; }); }
    var cp = await sb.from('broker_comp').select('*');   // RLS: rep sees own row only
    if (cp.error) degraded = true;
    else { _SK.compByRep = {}; (cp.data || []).forEach(function(c){ _SK.compByRep[c.rep_id] = c; }); }
    _SK.myRepId = null;
    if (currentUser && !currentUser.isAdmin) {
      var mine = _SK.reps.filter(function(r){ return r.profile_id === currentUser.userId; })[0];
      _SK.myRepId = mine ? mine.id : null;
    }
    _skBuildEffective();
    // Only snapshot a fully successful refresh — a degraded one must never
    // become the offline truth.
    if (!degraded) {
      try { localStorage.setItem('cesSalesApp:snapshot', JSON.stringify({ t: Date.now(), reps: _SK.reps, kpis: _SK.kpis, salesTeam: _SK.salesTeam, targets: _SK.targets })); } catch(e){}
    } else {
      toast('Some data could not be refreshed — figures may be partial', true);
    }
    var el = document.getElementById('lastSync'); if (el) el.textContent = 'Updated ' + new Date().toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'});
    if (showToast) toast('Data refreshed');
  } catch (e) {
    console.warn('refreshAll failed', e);
    // Offline / failed → fall back to last snapshot so the app still opens —
    // but never replace live in-memory data with an older snapshot.
    if (_SK.kpis.length || _SK.reps.length) { toast('Could not refresh — showing existing figures', true); return; }
    try {
      var snap = JSON.parse(localStorage.getItem('cesSalesApp:snapshot') || 'null');
      if (snap) {
        _SK.reps = snap.reps || []; _SK.kpis = snap.kpis || []; _SK.salesTeam = snap.salesTeam || [];
        _SK.targets = snap.targets || {}; _SK.sales = []; _SK.compByRep = {};
        if (currentUser) { var m2 = _SK.reps.filter(function(r){ return r.profile_id === currentUser.userId; })[0]; _SK.myRepId = m2 ? m2.id : null; }
        _skBuildEffective();
        var el2 = document.getElementById('lastSync'); if (el2) el2.textContent = 'Cached ' + new Date(snap.t).toLocaleString('en-GB');
        toast('Offline — showing cached figures', true);
      } else {
        toast('Could not load data — check your connection', true);
      }
    } catch(e2){ toast('Could not load data', true); }
  }
}
/* verbatim port of _skBuildEffective (sales.html:4921) */
function _skBuildEffective(){
  var map = {};
  function mk(rep, per){ var key = rep + '|' + per; if(!map[key]) map[key] = { rep_id:rep, period:per, _manualBilling:0, _manualNB:0, _salesCommRet:0, _salesCommNB:0, _salesCount:0 }; return map[key]; }
  _SK.kpis.forEach(function(k){
    var kk = mk(k.rep_id, k.period);
    for(var p in k){ if(Object.prototype.hasOwnProperty.call(k, p)) kk[p] = k[p]; }
    kk._manualBilling = Number(k.billing_total)||0;
    kk._manualNB = Number(k.new_business_gbp)||0;
  });
  (_SK.salesTeam||[]).forEach(function(s){
    var kk = mk(s.rep_id, s.period), rev = Number(s.revenue_gbp)||0, kwh = _skSaleContribKwh(s);
    kk.billing_total = (Number(kk.billing_total)||0) + rev;
    kk.total_kwh = (Number(kk.total_kwh)||0) + kwh;
    if(s.is_new_business){ kk.new_business_gbp = (Number(kk.new_business_gbp)||0) + rev; kk.new_business_kwh = (Number(kk.new_business_kwh)||0) + kwh; }
    kk._salesCount = (kk._salesCount||0) + 1;
  });
  (_SK.sales||[]).forEach(function(s){
    var kk = mk(s.rep_id, s.period), c = Number(s.commission_gbp)||0;
    if(s.is_new_business) kk._salesCommNB = (kk._salesCommNB||0) + c; else kk._salesCommRet = (kk._salesCommRet||0) + c;
  });
  _SK.eff = Object.keys(map).map(function(key){ return map[key]; });
}
function _skEffRow(repId, period){ return _SK.eff.filter(function(k){ return k.rep_id === repId && k.period === period; })[0] || null; }
/* verbatim port of _skCommission (sales.html:4872) */
function _skCommission(k, comp){
  if(!comp) return null;
  k = k || {};
  var manNB = Number(k._manualNB != null ? k._manualNB : k.new_business_gbp)||0;
  var manBill = Number(k._manualBilling != null ? k._manualBilling : k.billing_total)||0;
  var manRet = Math.max(0, manBill - manNB);
  var rC = manRet * (Number(comp.retained_rate)||0) / 100;
  var nC = manNB * (Number(comp.new_business_rate)||0) / 100;
  var salesRet = Number(k._salesCommRet)||0, salesNB = Number(k._salesCommNB)||0;
  return { commission: rC + salesRet + nC + salesNB };
}

/* ═══════════ app shell / tabs ═══════════ */
function enterApp(){
  document.getElementById('viewLogin').classList.add('hidden');
  document.getElementById('app').classList.add('on');
  _SK.fy = _skCurrentFyStart();
  var mu = document.getElementById('moreUser'); if (mu) mu.textContent = (currentUser.email || '').split('@')[0];
  showInstallHint();
  refreshAll(false).then(function(){
    _entryKey = _defaultEntryKey();
    renderAll();
  });
}
function _defaultEntryKey(){
  // current month if it's in the selected FY, else the FY's latest non-future month
  var cur = _thisMonthKey(), months = _fyMonths(_skFy()).filter(function(p){ return p <= cur; });
  if (!months.length) months = [_fyMonths(_skFy())[0]];
  return months.indexOf(cur) >= 0 ? cur : months[months.length - 1];
}
function renderAll(){
  renderEntryMonths(); loadEntry(); renderTrends(); renderTeamMonths(); renderTeam(); renderMore(); updateFyPill();
}
function _entryBusy(){
  var a = document.activeElement;
  return _dirty || (a && document.getElementById('panelEntry').contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'));
}
// Refresh every view EXCEPT the entry form while the broker is mid-entry —
// re-filling the form under their fingers loses keystrokes and caret position.
function renderAllSafe(){
  if (_entryBusy()) { renderTrends(); renderTeamMonths(); renderTeam(); renderMore(); updateFyPill(); }
  else renderAll();
}
var _TABS = { entry: ['panelEntry','tabEntry','My figures'], trends: ['panelTrends','tabTrends','Trends'], team: ['panelTeam','tabTeam','Team board'], more: ['panelMore','tabMore','More'] };
function showTab(t){
  Object.keys(_TABS).forEach(function(k){
    document.getElementById(_TABS[k][0]).classList.toggle('on', k === t);
    var b = document.getElementById(_TABS[k][1]);
    b.classList.toggle('on', k === t);
    b.setAttribute('aria-current', k === t ? 'page' : 'false');
  });
  document.getElementById('hdrTitle').textContent = _TABS[t][2];
  var rep = _SK.reps.filter(function(r){ return r.id === _SK.myRepId; })[0];
  document.getElementById('hdrSub').textContent = rep ? rep.name : (currentUser ? currentUser.name : '');
  if (t === 'trends') renderTrends();
  window.scrollTo({ top: 0 });
}
function updateFyPill(){ document.getElementById('hdrFy').textContent = _fyLabel(_skFy()); }
function cycleFy(){
  if (_dirty && !confirm('You have unsaved changes for ' + _skPeriodLabel(_entryKey) + '. They stay saved as a draft on this phone — switch year anyway?')) return;
  var list = _skFyList(); if (!list.length) return;
  var i = list.indexOf(_skFy());
  _SK.fy = list[(i + 1) % list.length];
  toast('Showing ' + _fyLabel(_SK.fy));
  _dirty = false;
  _entryKey = _defaultEntryKey();
  renderAll();
}

/* ═══════════ FIGURES tab ═══════════ */
function renderEntryMonths(){
  var host = document.getElementById('entryMonths');
  var cur = _thisMonthKey();
  // Desktop only ever offers months up to the current one (bxMonthOptionsHtml) —
  // a future month must never be saveable, let alone confirmable.
  var months = _fyMonths(_skFy()).filter(function(p){ return p <= cur; });
  host.innerHTML = months.map(function(p){
    var has = _SK.kpis.some(function(k){ return k.rep_id === _SK.myRepId && k.period === p; });
    return '<button type="button" class="chip' + (p === _entryKey ? ' on' : '') + (has ? ' dot' : '') + '" aria-pressed="' + (p === _entryKey) + '" data-p="' + escapeHtml(p) + '" onclick="pickMonth(this.dataset.p)">' + _skPeriodLabel(p) + (has ? '<span class="sr" style="position:absolute;left:-9999px;">figures entered</span>' : '') + '</button>';
  }).join('');
  var onEl = host.querySelector('.chip.on'); if (onEl) onEl.scrollIntoView({ inline: 'center', block: 'nearest' });
}
function pickMonth(p){
  if (_dirty && !confirm('You have unsaved changes for ' + _skPeriodLabel(_entryKey) + '. They stay saved as a draft on this phone — switch month anyway?')) return;
  _entryKey = p; renderEntryMonths(); loadEntry();
}
function buildEntryForm(){
  var host = document.getElementById('entryForm');
  host.innerHTML = _SECTIONS.map(function(sec){
    return '<div class="fsec"><div class="fsec-h">' + sec.title + '</div>' +
      sec.fields.map(function(fk){
        var f = _SK_FIELDS.filter(function(x){ return x[0] === fk; })[0];
        var unit = f[2], hint = f[3];
        return '<div class="frow"><label for="f_' + f[0] + '">' + f[1] +
          (hint ? '<small>' + hint + '</small>' : '') + '</label>' +
          '<div class="in"><input type="text" inputmode="decimal" enterkeyhint="next" id="f_' + f[0] + '" placeholder="0" autocomplete="off" oninput="entryChanged()" onblur="fmtField(this)" onfocus="unfmtField(this)"><span class="unit">' + unit + '</span></div></div>';
      }).join('') + '</div>';
  }).join('');
}
function _parseNum(v){
  v = String(v == null ? '' : v).trim();
  if (!v) return 0;
  if (/^\d+,\d{1,2}$/.test(v)) v = v.replace(',', '.');   // '1,5' typed as a decimal
  return parseFloat(v.replace(/,/g, '')) || 0;              // '1,500' as thousands
}
function _fVal(id){
  var el = document.getElementById(id); if (!el) return 0;
  var raw = (el.dataset.raw != null && document.activeElement !== el) ? el.dataset.raw : el.value;
  return _parseNum(raw);
}
function fmtField(el){
  var t = el.value.trim();
  // empty or no digits at all -> clear (same as desktop's parseFloat->NaN path)
  if (t === '' || !/[0-9]/.test(t)) { el.dataset.raw = ''; el.value = ''; return; }
  var v = _parseNum(t);
  el.dataset.raw = String(v);
  el.value = v.toLocaleString('en-GB', { maximumFractionDigits: 2 });
}
function unfmtField(el){ if (el.dataset.raw != null && el.dataset.raw !== '') el.value = el.dataset.raw; else if (el.value) el.value = String(el.value).replace(/,/g, ''); }
function _setField(id, v){
  var el = document.getElementById(id); if (!el) return;
  if (v == null || v === 0) { el.value = ''; el.dataset.raw = ''; }
  else { el.dataset.raw = String(v); el.value = Number(v).toLocaleString('en-GB', { maximumFractionDigits: 2 }); }
}
function loadEntry(){
  if (!document.getElementById('f_billing_total')) buildEntryForm();
  var row = _SK.kpis.filter(function(k){ return k.rep_id === _SK.myRepId && k.period === _entryKey; })[0] || null;
  _SK_FIELDS.forEach(function(f){ _setField('f_' + f[0], row ? row[f[0]] : null); });
  document.getElementById('f_lost_reason').value = (row && row.lost_reason) || '';
  cocSet(row ? row.customers_of_concern : null);
  _dirty = false; _restoredDraft = false;
  document.getElementById('draftBar').classList.remove('on');
  var confirmed = !!(row && row.confirmed_at);
  _locked = confirmed;
  if (confirmed) {
    // A confirmed month is the locked truth — never resurrect a stale local
    // draft on top of it, and drop the draft so it can't nag on every visit.
    try { localStorage.removeItem(_draftKey()); } catch(e){}
  } else {
    // draft newer than the saved row? offer it
    try {
      var d = JSON.parse(localStorage.getItem(_draftKey()) || 'null');
      if (d && (!row || !row.updated_at || d.t > new Date(row.updated_at).getTime())) {
        applyDraft(d); _restoredDraft = true;
        document.getElementById('draftMsg').textContent = 'Draft from ' + new Date(d.t).toLocaleString('en-GB', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}) + ' restored (not saved yet).';
        document.getElementById('draftBar').classList.add('on');
        _dirty = true;
      }
    } catch(e){}
  }
  var lb = document.getElementById('lockBar');
  lb.classList.toggle('on', confirmed);
  if (confirmed) lb.innerHTML = '🔒 Confirmed as your final total for ' + _skPeriodLabel(_entryKey) + ' on ' + new Date(row.confirmed_at).toLocaleDateString('en-GB') + ' — these figures are locked. Contact CES admin if something must change.';
  _setEntryEnabled(!confirmed);
  updateLive();
}
function _setEntryEnabled(on){
  document.querySelectorAll('#panelEntry input, #panelEntry textarea, #cocBody button, #cocRows button').forEach(function(el){ el.disabled = !on; });
  document.getElementById('saveBtn').disabled = !on;
  document.getElementById('confirmBtn').disabled = !on;
}
function entryChanged(){
  if (_locked) return;   // confirmed month: ignore any stray edit events
  _dirty = true; updateLive();
  clearTimeout(_draftTimer); _draftTimer = setTimeout(saveDraft, 500);
}
function updateLive(){
  var bill = _fVal('f_billing_total'), cons = _fVal('f_consultancy'), kwh = _fVal('f_total_kwh'), nb = _fVal('f_new_business_gbp');
  document.getElementById('liveBill').textContent = _skMoney(bill);
  document.getElementById('liveNb').textContent = _skMoney(nb);
  document.getElementById('liveUplift').textContent = kwh ? _skUplift(Math.max(0, bill - cons), kwh) : '—';
  // NB split reconciliation (advisory only — desktop doesn't block on it either)
  var g = _fVal('f_nb_organic_gbp') + _fVal('f_nb_recommendation_gbp') + _fVal('f_nb_prospecting_gbp');
  var kw = _fVal('f_nb_organic_kwh') + _fVal('f_nb_recommendation_kwh') + _fVal('f_nb_prospecting_kwh');
  var nbk = _fVal('f_new_business_kwh');
  var hint = document.getElementById('nbHint');
  if (!nb && !g && !nbk && !kw) { hint.className = 'hintbar'; }
  else if (Math.abs(g - nb) > 0.5 || Math.abs(kw - nbk) > 0.5) {
    hint.className = 'hintbar warn';
    hint.textContent = '△ New-business split doesn’t add up: breakdown £' + _skNum(g,0) + ' vs total £' + _skNum(nb,0) + (Math.abs(kw-nbk)>0.5 ? (' · ' + _skNum(kw,0) + ' vs ' + _skNum(nbk,0) + ' kWh') : '') + '. You can still save.';
  } else {
    hint.className = 'hintbar ok';
    hint.textContent = '✓ New-business split reconciles with the totals.';
  }
  var lc = _fVal('f_lost_customers'), lm = _fVal('f_lost_meters');
  document.getElementById('lossTag').textContent = (lc > 0 || lm > 0) ? 'required' : 'optional';
}

/* ── drafts (local only, per rep+month) ── */
function _draftKey(){ return 'cesSalesApp:draft:' + (_SK.myRepId || 'x') + ':' + _entryKey; }
function saveDraft(){
  if (!_dirty || !_SK.myRepId) return;
  var d = { t: Date.now(), fields: {}, lost_reason: document.getElementById('f_lost_reason').value, coc: cocGet() };
  _SK_FIELDS.forEach(function(f){ d.fields[f[0]] = _fVal('f_' + f[0]); });
  try { localStorage.setItem(_draftKey(), JSON.stringify(d)); } catch(e){}
}
function applyDraft(d){
  _SK_FIELDS.forEach(function(f){ _setField('f_' + f[0], d.fields ? d.fields[f[0]] : null); });
  document.getElementById('f_lost_reason').value = d.lost_reason || '';
  cocSet(d.coc);
}
function discardDraft(){
  try { localStorage.removeItem(_draftKey()); } catch(e){}
  _restoredDraft = false;
  loadEntry();
  toast('Draft discarded');
}

/* ── customers of concern (same 'No' | JSON [{c,r}] | null contract as sales.html) ── */
function cocRowHtml(c, r){
  return '<div class="coc-row"><input type="text" class="coc-c" placeholder="Customer" value="' + escapeHtml(c||'') + '" oninput="entryChanged()"><input type="text" class="coc-r" placeholder="Reason" value="' + escapeHtml(r||'') + '" oninput="entryChanged()"><button type="button" onclick="this.parentNode.remove(); entryChanged();" aria-label="Remove">×</button></div>';
}
function cocAdd(c, r){
  if (_locked) return;
  var no = document.getElementById('cocNo');
  if (no && no.checked) { no.checked = false; cocNoToggle(); }
  document.getElementById('cocRows').insertAdjacentHTML('beforeend', cocRowHtml(c, r));
  entryChanged();
}
function cocNoToggle(){
  var no = document.getElementById('cocNo'), body = document.getElementById('cocBody');
  if (body) body.style.display = (no && no.checked) ? 'none' : 'block';
  entryChanged();
}
function cocSet(val){
  var w = document.getElementById('cocRows'), no = document.getElementById('cocNo'); if (!w || !no) return;
  w.innerHTML = ''; no.checked = false;
  var v = (val == null ? '' : String(val)).trim();
  if (v) {
    if (v.toLowerCase() === 'no' || v.toLowerCase() === 'none') { no.checked = true; }
    else {
      var arr = null; try { arr = JSON.parse(v); } catch(e){}
      if (Array.isArray(arr)) { arr.forEach(function(o){ w.insertAdjacentHTML('beforeend', cocRowHtml((o && (o.c || o.customer)) || '', (o && (o.r || o.reason)) || '')); }); }
      else { w.insertAdjacentHTML('beforeend', cocRowHtml('', v)); }
    }
  }
  var body = document.getElementById('cocBody'); if (body) body.style.display = no.checked ? 'none' : 'block';
}
function cocGet(){
  var no = document.getElementById('cocNo'); if (no && no.checked) return 'No';
  var out = [];
  [].slice.call(document.querySelectorAll('#cocRows .coc-row')).forEach(function(rw){
    var c = (rw.querySelector('.coc-c').value || '').trim(), r = (rw.querySelector('.coc-r').value || '').trim();
    if (c || r) out.push({ c: c, r: r });
  });
  return out.length ? JSON.stringify(out) : null;
}
function _cocFilled(val){
  if (val == null) return false; var v = String(val).trim(); if (!v) return false;
  if (v.toLowerCase() === 'no' || v.toLowerCase() === 'none') return true;
  try { var a = JSON.parse(v); if (Array.isArray(a)) return a.some(function(o){ return o && String((o.c || o.customer || '')).trim(); }); } catch(e){}
  return v.length > 0;
}

/* ── save + confirm (same semantics as bxSaveMine / bxConfirmMonth) ── */
function _readEntry(){
  var rec = { rep_id: _SK.myRepId, period: _entryKey, updated_at: new Date().toISOString() };
  _SK_FIELDS.forEach(function(f){ rec[f[0]] = _fVal('f_' + f[0]); });
  var lr = document.getElementById('f_lost_reason').value.trim();
  rec.lost_reason = lr ? lr : null;
  rec.customers_of_concern = cocGet();
  // NOTE: no rec.notes — the desktop broker form omits it (admin-owned column);
  // including it here would overwrite Head-of-Sales notes on upsert.
  return rec;
}
async function saveMine(){
  if (!_SK.myRepId) { toast('Your sales profile isn’t linked yet — contact CES.', true); return; }
  if (_entryKey > _thisMonthKey()) { toast('That month hasn’t happened yet.', true); return; }
  if (!navigator.onLine) { toast('You’re offline — your draft is safe on this phone. Try again with signal.', true); return; }
  var _conf = _SK.kpis.filter(function(x){ return x.rep_id === _SK.myRepId && x.period === _entryKey && x.confirmed_at; })[0];
  if (_conf) { toast('You confirmed ' + _skPeriodLabel(_entryKey) + ' as final — figures are locked. Contact CES admin.', true); return; }
  var rec = _readEntry();
  if (((Number(rec.lost_customers)||0) > 0 || (Number(rec.lost_meters)||0) > 0) && !rec.lost_reason) {
    toast('You entered lost customers/meters — add a short reason why.', true);
    document.getElementById('f_lost_reason').focus();
    return;
  }
  var btn = document.getElementById('saveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  var resp = await sb.from('broker_kpis').upsert(rec, { onConflict: 'rep_id,period' });
  btn.disabled = false; btn.textContent = 'Save figures';
  if (resp.error) { toast('Could not save your figures — ' + (resp.error.message || 'try again'), true); return; }
  try { localStorage.removeItem(_draftKey()); } catch(e){}
  _dirty = false; _restoredDraft = false;
  document.getElementById('draftBar').classList.remove('on');
  // Merge the saved record into local state FIRST, so even a failed refresh
  // can never visually revert a successful save.
  var idx = -1;
  _SK.kpis.forEach(function(x, i){ if (x.rep_id === rec.rep_id && x.period === rec.period) idx = i; });
  if (idx >= 0) { for (var kk in rec) _SK.kpis[idx][kk] = rec[kk]; } else { _SK.kpis.push(rec); }
  _skBuildEffective();
  logAction('save_my_kpi', null, { period: _entryKey, via: 'app' });
  renderEntryMonths(); loadEntry(); renderTrends(); renderTeam(); renderMore();
  toast('Saved ✓');
  refreshAll(false).then(function(){ renderAllSafe(); });
}
async function confirmMonth(){
  if (!_SK.myRepId) { toast('Your sales profile isn’t linked yet.', true); return; }
  if (_entryKey > _thisMonthKey()) { toast('That month hasn’t happened yet.', true); return; }
  if (!navigator.onLine) { toast('You’re offline — confirming needs a connection.', true); return; }
  var lbl = _skPeriodLabel(_entryKey);
  var row = _SK.kpis.filter(function(x){ return x.rep_id === _SK.myRepId && x.period === _entryKey; })[0];
  if (!row) { toast('Save your figures for ' + lbl + ' first, then confirm.', true); return; }
  if (_dirty) { toast('You have unsaved changes — Save first, then confirm.', true); return; }
  if (!_cocFilled(row.customers_of_concern)) { toast('Before confirming ' + lbl + ': add at least one customer of concern (with the customer’s name) and Save — or tick “No customers of concern”.', true); return; }
  if (!confirm('Confirm ' + lbl + ' as your FINAL figures?\n\nAfter confirming you will NOT be able to change them — only CES admin can. Once every broker has confirmed, the month-end report is generated and emailed to management automatically.')) return;
  var resp = await sb.from('broker_kpis').update({ confirmed_at: new Date().toISOString() }).eq('rep_id', _SK.myRepId).eq('period', _entryKey);
  if (resp.error) { toast('Could not confirm your figures — ' + (resp.error.message || 'try again'), true); return; }
  row.confirmed_at = new Date().toISOString();
  logAction('confirm_month', null, { period: _entryKey, via: 'app' });
  loadEntry();
  toast('Confirmed — your ' + lbl + ' figures are locked 🔒');
  refreshAll(false).then(function(){ renderAllSafe(); });
}

/* ═══════════ TRENDS tab ═══════════ */
function _chartDefaults(){
  if (!window.Chart) return false;
  Chart.defaults.font.family = "'Manrope', sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = '#7a7e8c';
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) Chart.defaults.animation = false;
  return true;
}
function _mkChart(id, cfg){
  if (_charts[id]) { _charts[id].destroy(); }
  var el = document.getElementById(id); if (!el) return;
  _charts[id] = new Chart(el.getContext('2d'), cfg);
}
function renderTrends(){
  if (!document.getElementById('panelTrends').classList.contains('on') && document.getElementById('chBilling').dataset.drawn) return;
  if (!_chartDefaults()) return;
  var rep = _SK.reps.filter(function(r){ return r.id === _SK.myRepId; })[0];
  var months = _fyMonths(_skFy());
  var rows = months.map(function(p){ return _skEffRow(_SK.myRepId, p); });
  var lbls = months.map(function(p){ return _skPeriodLabel(p).replace(' 20', ' '); });
  var tgt = rep ? (Number(rep.monthly_target) || 0) : 0;
  document.getElementById('tgLbl').textContent = tgt ? ('target ' + _skMoney(tgt) + '/mo') : '';

  // this-month stat cards
  var curKey = _entryKey || _defaultEntryKey();
  var k = _skEffRow(_SK.myRepId, curKey) || {};
  var pct = tgt > 0 ? Math.round((Number(k.billing_total)||0) / tgt * 100) : null;
  var comm = _skCommission(k, _SK.compByRep[_SK.myRepId]);
  document.getElementById('trendStats').innerHTML =
    '<div class="stat"><div class="lbl">' + _skPeriodLabel(curKey) + ' billing</div><div class="val">' + _skMoney(k.billing_total) + '</div></div>' +
    '<div class="stat' + (pct != null ? (pct >= 100 ? ' ok' : (pct < 60 ? ' bad' : '')) : '') + '"><div class="lbl">% to target</div><div class="val">' + (pct != null ? pct + '%' : '—') + '</div><div class="sub">' + (tgt ? 'Target ' + _skMoney(tgt) : 'No target set') + '</div></div>' +
    '<div class="stat"><div class="lbl">Uplift p/kWh</div><div class="val">' + _skUplift(_skContractBill(k), k.total_kwh) + (_skHasOverride(k) ? '*' : '') + '</div></div>' +
    '<div class="stat"><div class="lbl">Commission earned</div><div class="val">' + (comm ? _skMoney(comm.commission) : '—') + '</div><div class="sub">' + (comm ? 'Excl. base salary' : 'Rates not set') + '</div></div>';

  var navy = '#2f3d7e', lime = '#93c43a', muted = '#c9c3b4';
  _mkChart('chBilling', {
    type: 'bar',
    data: { labels: lbls, datasets: [
      { label: 'Billing £', data: rows.map(function(r){ return r ? (Number(r.billing_total)||0) : 0; }), backgroundColor: navy, borderRadius: 5 }
    ].concat(tgt ? [{ label: 'Target', data: months.map(function(){ return tgt; }), type: 'line', borderColor: lime, borderWidth: 2, pointRadius: 0, borderDash: [6,4] }] : []) },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: function(v){ return '£' + (v >= 1000 ? (v/1000) + 'k' : v); } } } } }
  });
  _mkChart('chUplift', {
    type: 'line',
    data: { labels: lbls, datasets: [{ label: 'p/kWh', data: rows.map(function(r){ if (!r) return null; var kw = Number(r.total_kwh)||0; return kw ? +( _skContractBill(r)/kw*100 ).toFixed(2) : null; }), borderColor: navy, backgroundColor: 'rgba(47,61,126,0.08)', fill: true, spanGaps: true, tension: 0.3, pointRadius: 3, pointBackgroundColor: lime }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } } }
  });
  _mkChart('chNb', {
    type: 'bar',
    data: { labels: lbls, datasets: [
      { label: 'Organic', data: rows.map(function(r){ return r ? (Number(r.nb_organic_gbp)||0) : 0; }), backgroundColor: navy, borderRadius: 4 },
      { label: 'Recommendation', data: rows.map(function(r){ return r ? (Number(r.nb_recommendation_gbp)||0) : 0; }), backgroundColor: lime, borderRadius: 4 },
      { label: 'Prospecting', data: rows.map(function(r){ return r ? (Number(r.nb_prospecting_gbp)||0) : 0; }), backgroundColor: '#8a94c8', borderRadius: 4 }
    ] },
    options: { maintainAspectRatio: false, scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: function(v){ return '£' + (v >= 1000 ? (v/1000) + 'k' : v); } } } }, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10 } } } }
  });
  _mkChart('chKwh', {
    type: 'line',
    data: { labels: lbls, datasets: [{ label: 'kWh', data: rows.map(function(r){ return r ? (Number(r.total_kwh)||0) : 0; }), borderColor: lime, backgroundColor: 'rgba(147,196,58,0.12)', fill: true, tension: 0.3, pointRadius: 2 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: function(v){ return v >= 1000000 ? (v/1000000)+'M' : (v >= 1000 ? (v/1000)+'k' : v); } } } } }
  });
  document.getElementById('chBilling').dataset.drawn = '1';
}

/* ═══════════ TEAM tab (same aggregation + showLost rule as sales.html) ═══════════ */
function _skAggregate(periodKey){
  var out = {};
  _SK.reps.forEach(function(r){ out[r.id] = { rep_id: r.id, _n: 0, _contract_eff: 0, _has_override: false }; _SK_FIELDS.forEach(function(f){ out[r.id][f[0]] = 0; }); });
  var _fyset = {}; _fyMonths(_skFy()).forEach(function(p){ _fyset[p] = 1; });
  _SK.eff.forEach(function(k){
    if (periodKey === '__all__') { if (!_fyset[k.period]) return; }
    else if (k.period !== periodKey) return;
    var o = out[k.rep_id]; if (!o) return;
    _SK_FIELDS.forEach(function(f){ o[f[0]] += Number(k[f[0]]) || 0; });
    o._contract_eff += _skContractBill(k);
    if (_skHasOverride(k)) o._has_override = true;
    o._n++;
  });
  return out;
}
function renderTeamMonths(){
  var host = document.getElementById('teamMonths');
  var _fyset = {}; _fyMonths(_skFy()).forEach(function(p){ _fyset[p] = 1; });
  var periods = {}; _SK.eff.forEach(function(k){ if (_fyset[k.period]) periods[k.period] = 1; });
  var list = Object.keys(periods).sort().reverse();
  host.innerHTML = '<button type="button" class="chip' + (_teamKey === '__all__' ? ' on' : '') + '" aria-pressed="' + (_teamKey === '__all__') + '" data-p="__all__" onclick="pickTeam(this.dataset.p)">Full FY</button>' +
    list.map(function(p){ return '<button type="button" class="chip' + (p === _teamKey ? ' on' : '') + '" aria-pressed="' + (p === _teamKey) + '" data-p="' + escapeHtml(p) + '" onclick="pickTeam(this.dataset.p)">' + _skPeriodLabel(p) + '</button>'; }).join('');
}
function pickTeam(p){ _teamKey = p; renderTeamMonths(); renderTeam(); }
function renderTeam(){
  var host = document.getElementById('teamBoard');
  var cumulative = _teamKey === '__all__';
  var agg = _skAggregate(_teamKey);
  var rows = _SK.reps.map(function(r){ return { rep: r, a: agg[r.id] }; })
    .filter(function(x){ return x.a._n > 0 || x.a.billing_total > 0; })
    .sort(function(a, b){ return b.a.billing_total - a.a.billing_total; });
  var showLost = !!(currentUser && (currentUser.salesLead || currentUser.isAdmin));
  if (!rows.length) { host.innerHTML = '<div class="card" style="text-align:center;color:var(--muted);font-weight:700;">No figures for this period yet.</div>'; return; }
  var T = { bill: 0, nb: 0, kwh: 0, contract: 0, lostC: 0, lostK: 0 };
  var html = rows.map(function(x, i){
    var a = x.a, r = x.rep;
    T.bill += a.billing_total; T.nb += a.new_business_gbp; T.kwh += a.total_kwh; T.contract += a._contract_eff; T.lostC += a.lost_customers; T.lostK += a.lost_kwh;
    var me = r.id === _SK.myRepId;
    return '<div class="lb-row' + (me ? ' me' : '') + '">' +
      '<div class="lb-rank r' + (i + 1) + '">' + (i + 1) + '</div>' +
      '<div class="lb-main"><div class="lb-name">' + escapeHtml(r.name) + (me ? ' · you' : '') + '</div>' +
      '<div class="lb-sub">NB ' + _skMoney(a.new_business_gbp) + ' · ' + _skNum(a.total_kwh, 0) + ' kWh · ' + _skUplift(_skContractBill(a), a.total_kwh) + (_skHasOverride(a) ? '*' : '') + ' p/kWh' +
      (showLost ? (' · lost ' + _skNum(a.lost_customers, 0) + ' custs / ' + _skNum(a.lost_kwh, 0) + ' kWh') : '') + '</div></div>' +
      '<div class="lb-fig"><div class="v">' + _skMoney(a.billing_total) + '</div><div class="l">billing</div></div>' +
      '</div>';
  }).join('');
  html += '<div class="lb-row lb-total"><div class="lb-rank" style="background:rgba(255,255,255,0.12);color:#fff;">Σ</div>' +
    '<div class="lb-main"><div class="lb-name">Team' + (cumulative ? ' · ' + _fyLabel(_skFy()) : '') + '</div>' +
    '<div class="lb-sub">NB ' + _skMoney(T.nb) + ' · ' + _skNum(T.kwh, 0) + ' kWh · ' + _skUplift(T.contract, T.kwh) + ' p/kWh' +
    (showLost ? (' · lost ' + _skNum(T.lostC, 0) + ' custs') : '') + '</div></div>' +
    '<div class="lb-fig"><div class="v">' + _skMoney(T.bill) + '</div><div class="l">billing</div></div></div>';
  host.innerHTML = html;
}

/* ═══════════ MORE tab (annual progress = verbatim renderOverviewTarget math) ═══════════ */
function renderMore(){
  var rep = _SK.reps.filter(function(r){ return r.id === _SK.myRepId; })[0];
  document.getElementById('moreName').textContent = rep ? rep.name : (currentUser ? currentUser.name : '—');
  var host = document.getElementById('annualBody'), bar = document.getElementById('annualBar');
  if (!rep) { host.textContent = 'Your annual target appears once your profile is linked.'; bar.style.width = '0%'; return; }
  var cesY = (Number(rep.monthly_target) || 0) * 12;
  var _fy = _skFy(), fyLbl = _fyLabel(_fy);
  var _fyset = {}; _fyMonths(_fy).forEach(function(p){ _fyset[p] = 1; });
  var _nowKey = new Date().toISOString().slice(0, 7) + '-01';
  var monthsLeft = _fyMonths(_fy).filter(function(p){ return p >= _nowKey; }).length;
  var ytd = _SK.eff.filter(function(k){ return k.rep_id === _SK.myRepId && _fyset[k.period]; }).reduce(function(a, k){ return a + (Number(k.billing_total) || 0); }, 0);
  if (cesY <= 0) { host.innerHTML = 'No CES annual target set yet — ask CES to set your monthly target.'; bar.style.width = '0%'; return; }
  var mL = monthsLeft === 0 ? 'the year complete' : (monthsLeft + ' month' + (monthsLeft === 1 ? '' : 's') + ' left');
  var gap = cesY - ytd;
  var pct = Math.round(ytd / cesY * 100);
  if (gap > 0) {
    host.innerHTML = 'You are <b style="color:var(--fail);">' + _skMoney(gap) + '</b> away from your ' + fyLbl + ' target of <b>' + _skMoney(cesY) + '</b>, with <b>' + mL + '</b>. <span style="color:var(--muted);">(' + _skMoney(ytd) + ' billed · ' + pct + '%)</span>';
  } else {
    host.innerHTML = '🎉 You’ve <b style="color:var(--ok);">hit your ' + fyLbl + ' target</b> of <b>' + _skMoney(cesY) + '</b> — <b>' + _skMoney(-gap) + ' over</b>' + (monthsLeft > 0 ? ', with <b>' + mL + '</b>' : '') + '.';
  }
  bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  bar.style.background = pct >= 100 ? 'var(--ok)' : (pct >= 70 ? 'var(--navy)' : '#c9a23a');
}

/* ═══════════ install hint + service worker ═══════════ */
function _isStandalone(){ return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true; }
var _installPrompt = null;
window.addEventListener('beforeinstallprompt', function(e){ e.preventDefault(); _installPrompt = e; showInstallHint(); });
function showInstallHint(){
  var card = document.getElementById('installCard'), how = document.getElementById('installHow');
  if (_isStandalone()) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIos) {
    how.innerHTML = 'Put CES Sales on your home screen:<br>1. Tap the <b>Share</b> button <span style="font-family:var(--mono);">&#x2BAD;</span> in Safari’s toolbar<br>2. Scroll down and tap <b>Add to Home Screen</b><br>3. Tap <b>Add</b> — the app opens full-screen with its own icon';
  } else if (_installPrompt) {
    how.innerHTML = '<button class="btn primary" style="height:44px;" onclick="_installPrompt.prompt()" type="button">Install CES Sales</button>';
  } else {
    how.innerHTML = 'In Chrome: open the <b>⋮</b> menu and tap <b>Add to home screen / Install app</b>.';
  }
}
var _swReg = null;
function registerSw(){
  if (!('serviceWorker' in navigator)) { _setSwState('not supported'); return; }
  navigator.serviceWorker.register('/sales-sw.js', { scope: '/sales-app.html' }).then(function(reg){
    _swReg = reg;
    _setSwState('offline-ready');
    reg.addEventListener('updatefound', function(){
      var nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', function(){
        if (nw.state === 'installed' && navigator.serviceWorker.controller) document.getElementById('swUpdate').classList.add('on');
      });
    });
  }).catch(function(e){ console.warn('SW register failed', e); _setSwState('unavailable'); });
}
function _setSwState(s){ var el = document.getElementById('swState'); if (el) el.textContent = s; }
function applySwUpdate(){
  if (_swReg && _swReg.waiting) _swReg.waiting.postMessage('SKIP_WAITING');
  setTimeout(function(){ location.reload(); }, 250);
}

/* ═══════════ connectivity + lifecycle ═══════════ */
function _updateOnline(){ document.getElementById('offlineBanner').classList.toggle('on', !navigator.onLine); }
window.addEventListener('online', function(){ _updateOnline(); if (currentUser) refreshAll(false).then(renderAllSafe); });
window.addEventListener('offline', _updateOnline);
document.addEventListener('visibilitychange', async function(){
  if (document.visibilityState !== 'visible' || !currentUser) return;
  // iOS can freeze the tab for days: re-check the session and refresh quietly.
  try {
    if (!navigator.onLine) return;  // offline resume: keep showing cached data
    var s = await sb.auth.getSession();
    if (!s.data.session) {
      // Session lapsed: wipe the team-data snapshot (data at rest) but keep
      // the broker's own drafts — that unsaved work is exactly what they need
      // back after signing in again.
      try { localStorage.removeItem('cesSalesApp:snapshot'); localStorage.removeItem('cesSalesApp:profile'); } catch(e){}
      location.reload(); return;
    }
    refreshAll(false).then(renderAllSafe);
  } catch(e){}
});
// keep focused inputs visible above the iOS keyboard
document.addEventListener('focusin', function(e){
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
    setTimeout(function(){ try { e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch(_){} }, 300);
  }
});

/* ═══════════ boot ═══════════ */
document.getElementById('loginForm').addEventListener('submit', function(e){ e.preventDefault(); doLogin(); });
(async function boot(){
  registerSw();
  try { var u = localStorage.getItem('cesSalesApp:lastUser'); if (u) document.getElementById('loginUser').value = u; } catch(e){}
  _updateOnline();
  // If Turnstile never loads (blocked / offline), say so instead of leaving a
  // dead disabled button and an empty gap.
  setTimeout(function(){
    if (!window.turnstile && !currentUser && !document.getElementById('viewLogin').classList.contains('hidden')) {
      _loginErr('The security check could not load. Check your connection, or turn off any ad/privacy blocker for this site and reload.');
    }
  }, 6000);
  const { data: { session } } = await sb.auth.getSession();
  if (session && session.user) {
    await loadProfileAndEnter(session.user);
  }
})();
