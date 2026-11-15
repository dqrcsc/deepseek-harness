/**
 * Navigation glyph for the `network` Settings section.
 * @module @deepseek-ai/dsh-client-ui-settings-network/client/NetworkSectionIcon
 */

import { IconGlobeOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/**
 * Render the globe outline glyph inside the Settings navigation row.
 * @param props.size - requested square edge in pixels.
 * @returns SVG icon element.
 */
export function NetworkSectionIcon({ size }: PropsRuntime<'settings.section.icon'>) {
  return <IconGlobeOutlineMedium size={size} />
}
