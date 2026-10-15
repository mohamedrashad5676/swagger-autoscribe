import { describeVariants } from '../src/errors/error-description';

describe('describeVariants', () => {
  it('lists literal messages as code bullets', () => {
    expect(describeVariants([{ message: 'gone' }])).toEqual(['`gone`']);
  });

  it('sanitizes backticks inside messages', () => {
    expect(describeVariants([{ message: "say `hi`" }])).toEqual(["`say 'hi'`"]);
  });

  it('summarizes validation messages with samples', () => {
    const lines = describeVariants([{ messages: ['a must be a string', 'b must be an email'], isValidationPipe: true }]);
    expect(lines).toEqual(['Validation failed, e.g. "a must be a string"; "b must be an email"']);
  });

it('renders bare guard throws as when-conditions', () => {
     expect(describeVariants([{ condition: '!authHeader' }])).toEqual([]);
   });

  it('renders object bodies by field names', () => {
    const lines = describeVariants([{ schema: { type: 'object', properties: { waiting: { type: 'boolean' } } } }]);
    expect(lines).toEqual(['error object with fields: waiting']);
  });

  it('caps long lists', () => {
    const variants = Array.from({ length: 12 }, (_, i) => ({ message: `err${i}` }));
    const lines = describeVariants(variants);
    expect(lines.length).toBe(11);
    expect(lines[10]).toContain('+2 more');
  });
});
