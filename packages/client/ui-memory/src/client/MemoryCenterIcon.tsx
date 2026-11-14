/** Decorative occupant for the Memory center sidebar panel entry. */
import { IconPersonalizationOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the personalization glyph at the requested sidebar icon size.
 * @param props - sidebar panel icon dimensions.
 * @returns decorative sidebar icon.
 */
export function MemoryCenterIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconPersonalizationOutlineRegular size={size} />
}
