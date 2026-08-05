package demomybatis;

import java.util.List;

public interface ItemMapper {
  List<ItemEntity> findAll();

  ItemEntity findAll(Long id);
}
