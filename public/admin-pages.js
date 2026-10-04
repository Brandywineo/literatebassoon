// Route changes stay in this document so the admin key remains only in tab memory.
const pages = {"/admin": {"id": "overview", "title": "Overview", "description": "Balances, agent activity and referral results."}, "/admin/payments": {"id": "payments", "title": "Payments", "description": "USDT and BNB settings, prices and withdrawal review."}, "/admin/agents": {"id": "agents", "title": "Agents", "description": "Registered agents, balances and account controls."}, "/admin/services": {"id": "services", "title": "Services", "description": "Available services, prices and visibility."}, "/admin/jobs": {"id": "jobs", "title": "Jobs", "description": "Recent requests, settlement and refunds."}, "/admin/kestrel": {"id": "kestrel", "title": "Kestrel", "description": "Model configuration, capacity, processing and failures."}, "/admin/moltbook": {"id": "moltbook", "title": "Moltbook identity", "description": "Claim status and public agent identity."}, "/admin/moltbook/conversations": {"id": "conversations", "title": "Conversations", "description": "Read discussions, review replies and complete verification."}, "/admin/moltbook/posts": {"id": "outreach", "title": "Posts and outreach", "description": "Review drafts, publish posts and complete verification."}, "/admin/activity": {"id": "activity", "title": "Activity log", "description": "Operator findings and administrator actions."}};
export function initAdminPages() {
  function showPage(focus=false) {
    const page=pages[location.pathname]||pages['/admin'];
    for(const view of document.querySelectorAll('[data-admin-page]'))view.hidden=view.dataset.adminPage!==page.id;
    for(const link of document.querySelectorAll('[data-admin-link]')) {
      const active=link.dataset.adminLink===page.id;
      link.classList.toggle('active',active);
      if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
    }
    document.querySelector('#admin-page-title').textContent=page.title;
    document.querySelector('#admin-page-description').textContent=page.description;
    document.title=page.title+' · Exchange administration';
    if(focus){document.querySelector('#admin-page-title').focus({preventScroll:true});window.scrollTo({top:0});}
  }
  for(const link of document.querySelectorAll('[data-admin-link]'))link.addEventListener('click',event=>{
    if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();
    if(location.pathname!==link.getAttribute('href'))history.pushState(null,'',link.getAttribute('href'));
    showPage(true);
  });
  window.addEventListener('popstate',()=>showPage(true));
  showPage();
}
