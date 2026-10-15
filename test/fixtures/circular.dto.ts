// Synthetic fixture: no real DTO in this codebase is self-referencing, but
// cycle safety is a hard correctness requirement of the recursive DTO
// resolver and needs a case that actually exercises it.
export class CircularCategoryDto {
  name: string;
  children: CircularCategoryDto[];
}
