class Box {
  length = 0;
}

function solve(): number {
  const box = new Box();
  box.length = 4;
  return box.length;
}
