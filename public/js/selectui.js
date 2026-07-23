// Dropdown custom: substitui o menu nativo do <select> (que ignora o tema e
// destaca em azul do SO) por um menu estilizado no tema do app. O <select>
// real fica no DOM, funcional e escondido — value/change/fillSelect seguem
// funcionando; um MutationObserver re-renderiza quando as options mudam.

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const CARET = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>'

let openMenu = null // { menu, close } do dropdown aberto no momento

function closeOpen () { if (openMenu) { openMenu.close(); openMenu = null } }

function enhance (sel) {
  if (sel._selui) return
  sel._selui = true

  const wrap = document.createElement('div')
  wrap.className = 'selui'
  sel.parentNode.insertBefore(wrap, sel)
  wrap.appendChild(sel)
  sel.classList.add('selui-native')

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'selui-trigger'
  if (sel.title) trigger.title = sel.title
  wrap.appendChild(trigger)

  const label = document.createElement('span')
  label.className = 'selui-label'
  const caret = document.createElement('span')
  caret.className = 'selui-caret'
  caret.innerHTML = CARET
  trigger.append(label, caret)

  const menu = document.createElement('div')
  menu.className = 'selui-menu hidden'

  const renderLabel = () => {
    const o = sel.options[sel.selectedIndex]
    label.textContent = o ? o.textContent : ''
  }
  const buildMenu = () => {
    menu.innerHTML = ''
    for (const o of sel.options) {
      const it = document.createElement('button')
      it.type = 'button'
      it.className = 'selui-opt' + (o.selected ? ' on' : '')
      it.innerHTML = esc(o.textContent)
      it.addEventListener('click', () => {
        if (sel.value !== o.value) {
          sel.value = o.value
          sel.dispatchEvent(new Event('change', { bubbles: true }))
        }
        renderLabel()
        close()
      })
      menu.appendChild(it)
    }
  }

  const close = () => {
    menu.classList.add('hidden')
    trigger.classList.remove('open')
    if (menu.parentNode) menu.parentNode.removeChild(menu)
    if (openMenu && openMenu.menu === menu) openMenu = null
  }
  const open = () => {
    closeOpen()
    buildMenu()
    document.body.appendChild(menu) // no body pra escapar de overflow/containers
    const r = trigger.getBoundingClientRect()
    menu.style.minWidth = r.width + 'px'
    menu.classList.remove('hidden')
    trigger.classList.add('open')
    // posiciona; abre pra cima se não couber embaixo
    const mh = menu.offsetHeight
    const below = window.innerHeight - r.bottom
    const top = (below < mh + 8 && r.top > mh + 8) ? r.top - mh - 4 : r.bottom + 4
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px'
    menu.style.top = top + 'px'
    // destaca a opção ativa na visão
    const on = menu.querySelector('.selui-opt.on')
    if (on) on.scrollIntoView({ block: 'nearest' })
    openMenu = { menu, close }
  }

  trigger.addEventListener('click', e => {
    e.stopPropagation()
    if (trigger.classList.contains('open')) close(); else open()
  })

  // sincroniza quando o value muda por código (setar .value não dispara change)
  sel.addEventListener('change', renderLabel)
  // options trocadas (fillSelect) → refaz label; menu é reconstruído ao abrir
  const obs = new MutationObserver(() => renderLabel())
  obs.observe(sel, { childList: true })

  renderLabel()
}

export function enhanceSelects (root = document) {
  root.querySelectorAll('select').forEach(enhance)
}

// fecha o menu aberto ao clicar fora, rolar ou apertar Esc.
// captura (true): cliques em tabela/grupo do diagrama chamam stopPropagation,
// então o listener precisa rodar ANTES do bubbling ser interrompido.
document.addEventListener('mousedown', e => {
  if (!e.target.closest('.selui-menu') && !e.target.closest('.selui-trigger')) closeOpen()
}, true)
window.addEventListener('resize', closeOpen)
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeOpen() }, true)
