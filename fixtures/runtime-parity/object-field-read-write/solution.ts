class Box {
  value = 0;
}

function solve(): number {
  const box = new Box();
  box.value = 7;
  return box.value;
}
