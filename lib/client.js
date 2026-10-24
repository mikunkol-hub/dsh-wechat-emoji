// dsh-wechat-emoji 的客户端面板：注册到插件 bundle 配置区（plugins.bundle.config）。
// 在 DSH 设置页 → 插件 → 点进 dsh-wechat-emoji，页面里直接出现「智谱 API Key」设置区。
window.__ModuleLoader__.load({
  id: 'dsh-wechat-emoji',
  factory(require) {
    const React = require('react')
    const { useState, useEffect } = React
    const h = React.createElement

    const inputStyle = {
      width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: 13,
      borderRadius: 6, border: '1px solid var(--dsw-alias-stroke-secondary, #8883)', outline: 'none', background: 'transparent', color: 'inherit',
    }
    const buttonStyle = {
      alignSelf: 'flex-start', padding: '6px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
      border: '1px solid var(--dsw-alias-stroke-secondary, #8883)', background: 'transparent', color: 'inherit',
    }

    function SettingsPanel() {
      const [value, setValue] = useState('')
      const [hasKey, setHasKey] = useState(false)
      const [tail, setTail] = useState('')
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState('')

      useEffect(() => {
        fetch('/api/dsh-wechat-emoji/settings')
          .then((r) => r.json())
          .then((d) => { if (d?.ok) { setHasKey(!!d.hasKey); setTail(d.tail ?? '') } })
          .catch(() => {})
      }, [])

      const save = async () => {
        setBusy(true); setMsg('')
        try {
          const r = await fetch('/api/dsh-wechat-emoji/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: value }),
          })
          const d = await r.json()
          if (d?.ok) {
            setHasKey(value.length > 0)
            setTail(value ? '…' + value.slice(-4) : '')
            setValue('')
            setMsg('已保存，立即生效')
          } else {
            setMsg('保存失败：' + (d?.error ?? r.status))
          }
        } catch (error) {
          setMsg('保存失败：' + String(error?.message ?? error))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0 8px' } },
        h('div', { style: { fontSize: 13, opacity: 0.9 } },
          hasKey ? `智谱 API Key 已设置（${tail}）` : '智谱 API Key 未设置（留空时使用环境变量 ZHIPU_API_KEY）'),
        h('input', {
          type: 'password',
          placeholder: hasKey ? '粘贴新 Key 覆盖，留空清除' : '粘贴智谱 API Key',
          value, autoComplete: 'off', spellCheck: false,
          style: inputStyle,
          onChange: (e) => setValue(e.target.value),
        }),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('button', { onClick: save, disabled: busy, style: buttonStyle }, busy ? '保存中…' : '保存'),
          msg ? h('span', { style: { fontSize: 12, opacity: 0.85 } }, msg) : null),
        h('div', { style: { fontSize: 12, opacity: 0.65 } },
          '获取 Key：open.bigmodel.cn → API 密钥（GLM-4V-Flash 免费，新用户送额度）。'),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
          { name: 'plugins.bundle.config', key: 'dsh-wechat-emoji' },
          SettingsPanel,
        ))
      },
    }
  },
})
