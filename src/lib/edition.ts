export type EditionFormat = 'epub' | 'pdf' | 'mobi' | 'cbz'

export type Work = {
  id: string
  title: string
  author?: string
  editionIds: string[]
}

export type Edition = {
  id: string
  workId: string
  label: string
  language: string
  format: EditionFormat
  bookId: string
  progress: number
  location?: string
}

export type AlignmentMode = 'aligned' | 'independent'

export type Alignment = {
  id: string
  workId: string
  leftEditionId: string
  rightEditionId: string
  leftLocation?: string
  rightLocation?: string
  confidence: number
}

export function createWork(input: Omit<Work, 'id' | 'editionIds'> & { id?: string; editionIds?: string[] }): Work {
  return { id: input.id ?? crypto.randomUUID(), title: input.title, author: input.author, editionIds: input.editionIds ?? [] }
}

export function createEdition(input: Omit<Edition, 'id' | 'progress'> & { id?: string; progress?: number }): Edition {
  return { ...input, id: input.id ?? crypto.randomUUID(), progress: Math.max(0, Math.min(100, input.progress ?? 0)) }
}

export function linkEditions(work: Work, ...editions: Edition[]): Work {
  const ids = new Set(work.editionIds)
  editions.forEach((edition) => ids.add(edition.id))
  return { ...work, editionIds: [...ids] }
}

export function alignmentMode(alignment: Alignment | undefined, minimumConfidence = 0.72): AlignmentMode {
  return alignment && alignment.confidence >= minimumConfidence ? 'aligned' : 'independent'
}

export function swapAlignment(alignment: Alignment): Alignment {
  return { ...alignment, leftEditionId: alignment.rightEditionId, rightEditionId: alignment.leftEditionId, leftLocation: alignment.rightLocation, rightLocation: alignment.leftLocation }
}
