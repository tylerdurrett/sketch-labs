import { describe, expect, it } from 'vitest'
import { vec } from '../vec'

describe('add', () => {
  it('adds two Vec2', () => {
    expect(vec.add([1, 2], [3, 4])).toEqual([4, 6])
  })

  it('adds two Vec3', () => {
    expect(vec.add([1, 2, 3], [4, 5, 6])).toEqual([5, 7, 9])
  })

  it('identity with zero vector', () => {
    expect(vec.add([5, 3], [0, 0])).toEqual([5, 3])
  })
})

describe('sub', () => {
  it('subtracts two Vec2', () => {
    expect(vec.sub([5, 7], [2, 3])).toEqual([3, 4])
  })

  it('subtracts two Vec3', () => {
    expect(vec.sub([5, 7, 9], [1, 2, 3])).toEqual([4, 5, 6])
  })
})

describe('scale', () => {
  it('scales Vec2', () => {
    expect(vec.scale([2, 3], 4)).toEqual([8, 12])
  })

  it('scales Vec3', () => {
    expect(vec.scale([1, 2, 3], 2)).toEqual([2, 4, 6])
  })

  it('scale by zero', () => {
    expect(vec.scale([5, 3], 0)).toEqual([0, 0])
  })

  it('scale by negative', () => {
    expect(vec.scale([1, 2], -1)).toEqual([-1, -2])
  })
})

describe('negate', () => {
  it('negates Vec2', () => {
    expect(vec.negate([3, -4])).toEqual([-3, 4])
  })

  it('negates Vec3', () => {
    expect(vec.negate([1, -2, 3])).toEqual([-1, 2, -3])
  })
})

describe('dot', () => {
  it('perpendicular vectors return 0', () => {
    expect(vec.dot([1, 0], [0, 1])).toBe(0)
  })

  it('parallel vectors', () => {
    expect(vec.dot([1, 0], [1, 0])).toBe(1)
  })

  it('3D dot product', () => {
    expect(vec.dot([1, 2, 3], [4, 5, 6])).toBe(32)
  })

  it('opposite vectors return negative', () => {
    expect(vec.dot([1, 0], [-1, 0])).toBe(-1)
  })
})

describe('len', () => {
  it('unit vector', () => {
    expect(vec.len([1, 0])).toBe(1)
  })

  it('3-4-5 triangle', () => {
    expect(vec.len([3, 4])).toBe(5)
  })

  it('3D vector', () => {
    expect(vec.len([1, 2, 2])).toBe(3)
  })

  it('zero vector', () => {
    expect(vec.len([0, 0])).toBe(0)
  })
})

describe('lenSq', () => {
  it('squared length of Vec2', () => {
    expect(vec.lenSq([3, 4])).toBe(25)
  })

  it('squared length of Vec3', () => {
    expect(vec.lenSq([1, 2, 2])).toBe(9)
  })
})

describe('normalize', () => {
  it('normalizes Vec2', () => {
    const result = vec.normalize([3, 4])
    expect(result[0]).toBeCloseTo(0.6)
    expect(result[1]).toBeCloseTo(0.8)
  })

  it('normalizes Vec3', () => {
    const result = vec.normalize([0, 0, 5])
    expect(result[0]).toBeCloseTo(0)
    expect(result[1]).toBeCloseTo(0)
    expect(result[2]).toBeCloseTo(1)
  })

  it('zero vector returns zero vector', () => {
    expect(vec.normalize([0, 0])).toEqual([0, 0])
  })

  it('result has unit length', () => {
    expect(vec.len(vec.normalize([7, 11]))).toBeCloseTo(1)
  })
})

describe('dist', () => {
  it('distance between two points (3-4-5 triangle)', () => {
    expect(vec.dist([0, 0], [3, 4])).toBe(5)
  })

  it('distance in 3D', () => {
    expect(vec.dist([0, 0, 0], [1, 2, 2])).toBe(3)
  })

  it('distance to self is 0', () => {
    expect(vec.dist([5, 3], [5, 3])).toBe(0)
  })
})

describe('distSq', () => {
  it('squared distance', () => {
    expect(vec.distSq([0, 0], [3, 4])).toBe(25)
  })

  it('3D squared distance', () => {
    expect(vec.distSq([1, 1, 1], [4, 5, 1])).toBe(25)
  })
})

describe('lerp', () => {
  it('t=0 returns a', () => {
    expect(vec.lerp([0, 0], [10, 20], 0)).toEqual([0, 0])
  })

  it('t=1 returns b', () => {
    expect(vec.lerp([0, 0], [10, 20], 1)).toEqual([10, 20])
  })

  it('t=0.5 returns midpoint', () => {
    expect(vec.lerp([0, 0], [10, 20], 0.5)).toEqual([5, 10])
  })

  it('works for Vec3', () => {
    expect(vec.lerp([0, 0, 0], [10, 20, 30], 0.5)).toEqual([5, 10, 15])
  })

  it('extrapolates beyond 1', () => {
    expect(vec.lerp([0, 0], [10, 0], 2)).toEqual([20, 0])
  })
})

describe('angleBetween', () => {
  it('perpendicular vectors', () => {
    expect(vec.angleBetween([1, 0], [0, 1])).toBeCloseTo(Math.PI / 2)
  })

  it('parallel vectors', () => {
    expect(vec.angleBetween([1, 0], [2, 0])).toBeCloseTo(0)
  })

  it('opposite vectors', () => {
    expect(vec.angleBetween([1, 0], [-1, 0])).toBeCloseTo(Math.PI)
  })

  it('3D vectors at 90 degrees', () => {
    expect(vec.angleBetween([1, 0, 0], [0, 1, 0])).toBeCloseTo(Math.PI / 2)
  })

  it('returns 0 for zero-length vector', () => {
    expect(vec.angleBetween([0, 0], [1, 0])).toBe(0)
  })
})

describe('perpendicular', () => {
  it('rotates [1, 0] to [0, 1]', () => {
    const result = vec.perpendicular([1, 0])
    expect(result[0]).toBe(0)
    expect(result[1]).toBe(1)
  })

  it('rotates [0, 1] to [-1, 0]', () => {
    expect(vec.perpendicular([0, 1])).toEqual([-1, 0])
  })

  it('arbitrary vector', () => {
    expect(vec.perpendicular([3, 4])).toEqual([-4, 3])
  })

  it('result is perpendicular (dot product is 0)', () => {
    const v: [number, number] = [7, 11]
    expect(vec.dot(v, vec.perpendicular(v))).toBe(0)
  })
})

describe('cross', () => {
  it('standard basis i × j = k', () => {
    expect(vec.cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1])
  })

  it('reversed order j × i = -k', () => {
    expect(vec.cross([0, 1, 0], [1, 0, 0])).toEqual([0, 0, -1])
  })

  it('parallel vectors return zero vector', () => {
    expect(vec.cross([1, 0, 0], [2, 0, 0])).toEqual([0, 0, 0])
  })

  it('arbitrary vectors', () => {
    expect(vec.cross([1, 2, 3], [4, 5, 6])).toEqual([-3, 6, -3])
  })
})

describe('projectOrthographic', () => {
  it('drops z by default', () => {
    expect(vec.projectOrthographic([1, 2, 3])).toEqual([1, 2])
  })

  it('drops z explicitly', () => {
    expect(vec.projectOrthographic([1, 2, 3], 'z')).toEqual([1, 2])
  })

  it('drops x', () => {
    expect(vec.projectOrthographic([1, 2, 3], 'x')).toEqual([2, 3])
  })

  it('drops y', () => {
    expect(vec.projectOrthographic([1, 2, 3], 'y')).toEqual([1, 3])
  })
})

describe('projectPerspective', () => {
  it('basic perspective divide', () => {
    const result = vec.projectPerspective([2, 4, 8], 4)
    expect(result[0]).toBeCloseTo(1)
    expect(result[1]).toBeCloseTo(2)
  })

  it('focal length 1', () => {
    const result = vec.projectPerspective([3, 6, 3], 1)
    expect(result[0]).toBeCloseTo(1)
    expect(result[1]).toBeCloseTo(2)
  })

  it('point at z equals focal length', () => {
    const result = vec.projectPerspective([5, 10, 5], 5)
    expect(result[0]).toBeCloseTo(5)
    expect(result[1]).toBeCloseTo(10)
  })
})

describe('immutability', () => {
  it('add does not mutate inputs', () => {
    const a: [number, number] = [1, 2]
    const b: [number, number] = [3, 4]
    vec.add(a, b)
    expect(a).toEqual([1, 2])
    expect(b).toEqual([3, 4])
  })

  it('scale does not mutate input', () => {
    const a: [number, number] = [1, 2]
    vec.scale(a, 5)
    expect(a).toEqual([1, 2])
  })

  it('normalize does not mutate input', () => {
    const a: [number, number] = [3, 4]
    vec.normalize(a)
    expect(a).toEqual([3, 4])
  })
})
